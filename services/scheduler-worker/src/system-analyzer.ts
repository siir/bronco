import type { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import { TaskType } from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('system-analyzer');

const MAX_EVENTS = 50;
const MAX_EVENT_CONTENT = 500;
const MAX_DEDUP_ENTRY_LENGTH = 300;

/**
 * Analyzes a closed ticket and generates system improvement suggestions.
 * Fetches the most recent events (up to {@link MAX_EVENTS}), existing
 * pending/rejected analyses for dedup context, and calls the AI to produce
 * an analysis.
 */
export async function analyzeTicketClosure(
  db: PrismaClient,
  ai: AIRouter,
  ticketId: string,
): Promise<void> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      client: { select: { id: true, name: true, shortCode: true } },
      system: { select: { name: true } },
      events: { orderBy: { createdAt: 'desc' }, take: MAX_EVENTS },
    },
  });

  if (!ticket) {
    logger.warn({ ticketId }, 'Ticket not found for closure analysis');
    return;
  }

  // Build ticket context for the AI (last MAX_EVENTS, truncate content to MAX_EVENT_CONTENT chars each)
  // Events were fetched in desc order; reverse to chronological for the prompt.
  const recentEvents = [...ticket.events].reverse();
  const eventLog = recentEvents
    .map(
      (e) => {
        const content = e.content
          ? (e.content.length > MAX_EVENT_CONTENT ? e.content.slice(0, MAX_EVENT_CONTENT) + '...' : e.content)
          : '(no content)';
        return `[${e.createdAt.toISOString()}] ${e.eventType}${e.actor ? ` (${e.actor})` : ''}: ${content}`;
      },
    )
    .join('\n');

  // Fetch existing analyses for dedup context (scoped to same client)
  const [pendingAnalyses, rejectedAnalyses] = await Promise.all([
    db.systemAnalysis.findMany({
      where: { status: 'PENDING', clientId: ticket.clientId },
      select: { suggestions: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    db.systemAnalysis.findMany({
      where: { status: 'REJECTED', clientId: ticket.clientId },
      select: { suggestions: true, rejectionReason: true },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ]);

  const truncate = (text: string, max: number): string =>
    text.length > max
      ? max > 3
        ? text.slice(0, max - 3) + '...'
        : text.slice(0, max)
      : text;

  const pendingSummary =
    pendingAnalyses.length > 0
      ? pendingAnalyses.map((a) => truncate(a.suggestions, MAX_DEDUP_ENTRY_LENGTH)).join('\n---\n')
      : 'None';

  const rejectedSummary =
    rejectedAnalyses.length > 0
      ? rejectedAnalyses
          .map(
            (a) =>
              `Suggestions: ${truncate(a.suggestions, MAX_DEDUP_ENTRY_LENGTH)}\nRejection reason: ${truncate(a.rejectionReason ?? 'Not specified', MAX_DEDUP_ENTRY_LENGTH)}`,
          )
          .join('\n---\n')
      : 'None';

  const userPrompt =
    `## Ticket Details\n` +
    `- **Subject**: ${ticket.subject}\n` +
    `- **Description**: ${ticket.description ?? 'N/A'}\n` +
    `- **Category**: ${ticket.category ?? 'N/A'}\n` +
    `- **Priority**: ${ticket.priority}\n` +
    `- **Source**: ${ticket.source}\n` +
    `- **Status**: ${ticket.status}\n` +
    `- **Client**: ${ticket.client.name} (${ticket.client.shortCode})\n` +
    `- **System**: ${ticket.system?.name ?? 'N/A'}\n` +
    `- **Created**: ${ticket.createdAt.toISOString()}\n` +
    `- **Resolved**: ${ticket.resolvedAt?.toISOString() ?? 'N/A'}\n` +
    `- **Summary**: ${ticket.summary ?? 'N/A'}\n\n` +
    `## Event Log\n${eventLog}\n\n` +
    `## Existing Pending Analyses (DO NOT DUPLICATE)\n${pendingSummary}\n\n` +
    `## Previously Rejected Analyses (DO NOT RE-SUGGEST)\n${rejectedSummary}`;

  try {
    const response = await ai.generate({
      taskType: TaskType.ANALYZE_TICKET_CLOSURE,
      prompt: userPrompt,
      promptKey: 'system-analysis.closure.system',
      context: { entityId: ticketId, entityType: 'ticket', clientId: ticket.clientId },
    });

    // Parse the response into analysis and suggestions sections (order-independent)
    const content = response.content;
    let analysis: string;
    let suggestions: string;

    const suggestionsIdx = content.indexOf('## Suggestions');
    const analysisIdx = content.indexOf('## Analysis');

    if (analysisIdx !== -1 && suggestionsIdx !== -1) {
      // Both sections present — extract each regardless of order
      const analysisStart = analysisIdx + '## Analysis'.length;
      const suggestionsStart = suggestionsIdx + '## Suggestions'.length;

      if (analysisIdx < suggestionsIdx) {
        analysis = content.substring(analysisStart, suggestionsIdx).trim();
        suggestions = content.substring(suggestionsStart).trim();
      } else {
        suggestions = content.substring(suggestionsStart, analysisIdx).trim();
        analysis = content.substring(analysisStart).trim();
      }
    } else if (analysisIdx !== -1) {
      analysis = content.substring(analysisIdx + '## Analysis'.length).trim();
      suggestions = '';
    } else if (suggestionsIdx !== -1) {
      suggestions = content.substring(suggestionsIdx + '## Suggestions'.length).trim();
      const before = content.substring(0, suggestionsIdx).trim();
      analysis = before || content.trim();
    } else {
      analysis = content.trim();
      suggestions = '';
    }

    await db.systemAnalysis.create({
      data: {
        ticketId,
        clientId: ticket.clientId,
        analysis,
        suggestions,
        aiModel: response.model,
        aiProvider: response.provider,
      },
    });

    logger.info(
      { ticketId, provider: response.provider, model: response.model },
      'Ticket closure analysis completed',
    );
  } catch (err) {
    logger.error({ err, ticketId }, 'Failed to analyze ticket closure');
    throw err;
  }
}
