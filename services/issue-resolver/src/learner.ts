import { getDb } from '@bronco/db';
import { TaskType, MemorySource, MemoryType, TicketCategory } from '@bronco/shared-types';
import type { ResolutionPlan } from '@bronco/shared-types';
import type { AIRouter, ClientMemoryResolver } from '@bronco/ai-provider';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('issue-resolver:learner');

// ─── Types ───

interface LearningEntry {
  title: string;
  content: string;
  memoryType: typeof MemoryType.CONTEXT | typeof MemoryType.PLAYBOOK;
  category: string | null;
  tags: string[];
}

interface LearningContext {
  ai: AIRouter;
  clientMemoryResolver: ClientMemoryResolver;
  clientId: string;
  ticketId: string;
  issueCategory: string | null;
}

// ─── AI Extraction ───

async function askAIForLearning(
  ai: AIRouter,
  clientId: string,
  prompt: string,
): Promise<LearningEntry | null> {
  const response = await ai.generate({
    taskType: TaskType.CUSTOM_AI_QUERY,
    prompt,
    systemPrompt: `You extract reusable lessons from operator corrections to AI-generated plans.
Return a JSON object with these fields:
- "title": A short, descriptive title for this lesson (max 80 chars). Must be unique — think of it as a rule name.
- "content": The reusable lesson in markdown. Be concise but specific. Include what to do AND what to avoid.
- "memoryType": Either "CONTEXT" (general knowledge/constraint) or "PLAYBOOK" (step-by-step procedure).
- "category": The ticket category this applies to (e.g. "DATABASE_PERF", "BUG_FIX", "CODE_REVIEW"), or null if it applies broadly.
- "notable": true if this is a meaningful, reusable lesson; false if it's too specific to this one case or too generic to be useful.

Return ONLY the JSON object, no markdown fences.`,
    context: { clientId, skipClientMemory: true },
  });

  try {
    const parsed = JSON.parse(response.content.trim());
    if (!parsed.notable) return null;
    if (!parsed.title || !parsed.content) return null;

    return {
      title: String(parsed.title).slice(0, 120),
      content: String(parsed.content),
      memoryType: parsed.memoryType === MemoryType.PLAYBOOK ? MemoryType.PLAYBOOK : MemoryType.CONTEXT,
      category: parsed.category || null,
      tags: [],
    };
  } catch {
    logger.warn({ response: response.content.slice(0, 200) }, 'Failed to parse learning extraction response');
    return null;
  }
}

// ─── Persistence ───

async function persistLearning(
  ctx: LearningContext,
  entry: LearningEntry,
  eventTags: string[],
): Promise<void> {
  const db = getDb();
  const tags = [...new Set([...entry.tags, ...eventTags, `ticket:${ctx.ticketId}`])];

  // Check for duplicate using the unique constraint (clientId, title)
  const existing = await db.clientMemory.findUnique({
    where: {
      clientId_title: {
        clientId: ctx.clientId,
        title: entry.title,
      },
    },
  });

  if (existing) {
    if (existing.source === MemorySource.MANUAL) {
      // Respect manually curated memories — do not overwrite or duplicate
      logger.info(
        { memoryId: existing.id, clientId: ctx.clientId, title: entry.title },
        'Skipping learned memory because a manual memory already exists for this title',
      );
      return;
    }

    // Update existing AI-learned memory with enriched content
    await db.clientMemory.update({
      where: { id: existing.id },
      data: {
        content: entry.content,
        tags: [...new Set([...existing.tags, ...tags])],
      },
    });
    logger.info({ memoryId: existing.id, title: entry.title }, 'Updated existing learned memory');
  } else {
    await db.clientMemory.create({
      data: {
        clientId: ctx.clientId,
        title: entry.title,
        memoryType: entry.memoryType,
        category: entry.category && Object.values(TicketCategory).includes(entry.category as TicketCategory)
          ? entry.category as TicketCategory
          : (ctx.issueCategory && Object.values(TicketCategory).includes(ctx.issueCategory as TicketCategory)
            ? ctx.issueCategory as TicketCategory
            : null),
        tags,
        content: entry.content,
        source: MemorySource.AI_LEARNED,
        sortOrder: 0,
      },
    });
    logger.info({ clientId: ctx.clientId, title: entry.title }, 'Created new learned memory');
  }

  ctx.clientMemoryResolver.invalidate(ctx.clientId);
}

// ─── Public API ───

/**
 * Extract learning from a plan rejection with operator feedback.
 * Highest-value signal — the operator explicitly corrected the AI.
 */
export async function extractLearningFromRejection(
  ctx: LearningContext,
  rejectedPlan: ResolutionPlan,
  feedback: string,
): Promise<void> {
  const prompt = `## Rejected Plan
**Summary:** ${rejectedPlan.summary}
**Approach:** ${rejectedPlan.approach}
**Actions:**
${rejectedPlan.actions.map(a => `- [${a.category}] ${a.description}`).join('\n')}

## Operator Feedback (reason for rejection)
${feedback}

## Task
Extract the reusable lesson from this rejection. What should the AI remember for future plans for this client? Focus on the operator's correction — what was wrong with the approach and what should be done instead.`;

  const entry = await askAIForLearning(ctx.ai, ctx.clientId, prompt);
  if (entry) {
    await persistLearning(ctx, entry, ['resolution-learning', 'plan-rejection']);
  }
}

/**
 * Extract learning from a plan approval.
 * Lower weight — only extract if the approach was non-obvious.
 */
export async function extractLearningFromApproval(
  ctx: LearningContext,
  approvedPlan: ResolutionPlan,
): Promise<void> {
  const prompt = `## Approved Plan
**Summary:** ${approvedPlan.summary}
**Approach:** ${approvedPlan.approach}
**Actions:**
${approvedPlan.actions.map(a => `- [${a.category}] ${a.description}`).join('\n')}

## Task
The operator approved this plan. Is there a reusable lesson here about client preferences or architectural decisions? Only set "notable" to true if the approach reflects a non-obvious preference or architectural constraint that would be useful to remember for future plans. Generic best practices are NOT notable.`;

  const entry = await askAIForLearning(ctx.ai, ctx.clientId, prompt);
  if (entry) {
    await persistLearning(ctx, entry, ['resolution-learning', 'plan-approval']);
  }
}

/**
 * Extract learning from plan iteration — what changed between the rejected and new plan.
 */
export async function extractLearningFromIteration(
  ctx: LearningContext,
  previousPlan: ResolutionPlan,
  newPlan: ResolutionPlan,
  feedback: string,
): Promise<void> {
  const prompt = `## Previous Plan (rejected)
**Summary:** ${previousPlan.summary}
**Approach:** ${previousPlan.approach}

## Updated Plan (after feedback)
**Summary:** ${newPlan.summary}
**Approach:** ${newPlan.approach}

## Operator Feedback
${feedback}

## Task
Compare the two plans. What direction did the operator push the AI in? Extract a reusable preference or constraint. Focus on the pattern of correction — e.g., "prefer X over Y", "never modify Z directly", "always use approach A for this type of issue". Only set "notable" to true if the difference reveals a meaningful, reusable preference.`;

  const entry = await askAIForLearning(ctx.ai, ctx.clientId, prompt);
  if (entry) {
    await persistLearning(ctx, entry, ['resolution-learning', 'plan-iteration']);
  }
}
