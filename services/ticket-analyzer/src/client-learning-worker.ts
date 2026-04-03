import type { PrismaClient } from '@bronco/db';
import type { AIRouter, ClientMemoryResolver } from '@bronco/ai-provider';
import { createLogger } from '@bronco/shared-utils';
import { MemoryType, MemorySource, TicketCategory, TaskType } from '@bronco/shared-types';

const logger = createLogger('client-learning-worker');

export interface ClientLearningJob {
  ticketId: string;
  clientId: string;
}

export async function processClientLearningJob(
  job: ClientLearningJob,
  db: PrismaClient,
  aiRouter: AIRouter,
  clientMemoryResolver: ClientMemoryResolver,
): Promise<void> {
  const { ticketId, clientId } = job;

  // Load full ticket context
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: {
      events: { orderBy: { createdAt: 'asc' } },
      client: { select: { name: true } },
    },
  });

  if (!ticket) {
    logger.warn({ ticketId }, 'Ticket not found for client learning extraction — skipping');
    return;
  }

  // Load existing client memories to avoid duplication
  const existingMemories = await db.clientMemory.findMany({
    where: { clientId, isActive: true },
    select: { memoryType: true, content: true },
  });

  // Build prompt content
  const ticketSummary = [
    `# Ticket: ${ticket.subject}`,
    `Category: ${ticket.category ?? 'GENERAL'}`,
    `Status: ${ticket.status}`,
    `Description: ${ticket.description ?? '(none)'}`,
    '',
    '## Events',
    ...ticket.events.map(e =>
      `[${e.createdAt.toISOString()}] ${e.eventType}: ${e.content ?? '(no content)'}`,
    ),
  ].join('\n');

  const existingMemorySummary = existingMemories.length > 0
    ? '## Existing Client Memories (do not duplicate)\n' +
      existingMemories.map(m => `- [${m.memoryType}] ${m.content.slice(0, 200)}`).join('\n')
    : '## Existing Client Memories\n(none yet)';

  const userPrompt = [
    `Client: ${ticket.client?.name ?? clientId}`,
    '',
    ticketSummary,
    '',
    existingMemorySummary,
  ].join('\n');

  // Run AI extraction
  let responseText: string;
  try {
    const result = await aiRouter.generate({
      taskType: TaskType.EXTRACT_CLIENT_LEARNINGS,
      promptKey: 'client-memory.learning.system',
      prompt: userPrompt,
      context: { clientId, skipClientMemory: true, entityId: ticketId, entityType: 'ticket' },
    });
    responseText = result.content;
  } catch (err) {
    logger.error({ err, ticketId, clientId }, 'AI call failed for client learning extraction');
    return;
  }

  // Parse JSON array from response
  let learnings: Array<{ type: string; content: string; category: string | null }>;
  try {
    // Strip markdown fences if present
    const cleaned = responseText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    learnings = JSON.parse(cleaned);
    if (!Array.isArray(learnings)) {
      logger.warn({ ticketId }, 'AI returned non-array for client learnings — skipping');
      return;
    }
  } catch {
    logger.warn({ ticketId, responseText: responseText.slice(0, 500) }, 'Failed to parse client learnings JSON — skipping');
    return;
  }

  if (learnings.length === 0) {
    logger.info({ ticketId, clientId }, 'No new client learnings extracted from ticket');
    return;
  }

  // Write to ClientMemory
  const VALID_TYPES = new Set(Object.values(MemoryType));
  const VALID_CATEGORIES = new Set<string | null>([...Object.values(TicketCategory), null]);

  let created = 0;
  for (const item of learnings) {
    if (!VALID_TYPES.has(item.type as MemoryType)) {
      logger.warn({ item }, 'Invalid memory type in AI response — skipping entry');
      continue;
    }
    if (!item.content || typeof item.content !== 'string') continue;

    const category = VALID_CATEGORIES.has(item.category)
      ? (item.category as TicketCategory | null)
      : null;

    // Generate a short title from the content (first line, truncated)
    const title = item.content.trim().split('\n')[0].slice(0, 120);

    await db.clientMemory.create({
      data: {
        clientId,
        title,
        memoryType: item.type as MemoryType,
        content: item.content.trim(),
        source: MemorySource.AI_LEARNED,
        category,
        isActive: true,
      },
    });
    created++;
  }

  // Invalidate the resolver cache so new memories are picked up
  clientMemoryResolver.invalidate(clientId);

  logger.info({ ticketId, clientId, created }, 'Client learning extraction complete');
}
