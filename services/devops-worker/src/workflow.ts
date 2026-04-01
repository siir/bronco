import type { PrismaClient } from '@bronco/db';
import { WorkflowState, TaskType } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { createLogger, AppLogger, createPrismaLogWriter } from '@bronco/shared-utils';
import type { AzDoClient } from './client.js';
import { TicketWorkflowTarget, type WorkflowTarget, type WorkflowContext } from './workflow-target.js';

/** Set of all valid WorkflowState values for runtime validation. */
const WORKFLOW_STATE_VALUES = new Set<string>(Object.values(WorkflowState));

/** Type guard: validate that a string from the DB is a known WorkflowState. */
function isWorkflowState(value: string): value is WorkflowState {
  return WORKFLOW_STATE_VALUES.has(value);
}

const logger = createLogger('azdo-workflow');
export const appLog = new AppLogger('azdo-workflow');

export function initWorkflowLogger(db: PrismaClient): void {
  appLog.setWriter(createPrismaLogWriter(db));
}

export const BOT_MARKER = '<!-- bronco-bot -->';

/** Default maximum number of question-answer rounds before forcing a plan. */
const DEFAULT_MAX_QUESTION_ROUNDS = 10;

export interface PlanStep {
  step: number;
  description: string;
  type: 'analysis' | 'sql' | 'code' | 'manual' | 'verification';
  details: string;
}

const CommentIntent = {
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
} as const;
type CommentIntent = (typeof CommentIntent)[keyof typeof CommentIntent];

/**
 * Drives the conversational workflow for actionable Azure DevOps work items.
 *
 * State machine:
 *   idle → analyzing → questioning → planning → awaiting_approval → executing → completed
 *
 * On each invocation, reads the current state and advances it based on
 * the latest entity events (DevOps comments, AI outputs, etc.).
 */
export class WorkflowEngine {
  /** In-process lock to prevent concurrent processing of the same work item. */
  private processing = new Set<number>();
  private maxQuestionRounds: number;
  private integrationId: string | null;
  private target: WorkflowTarget;

  constructor(
    private db: PrismaClient,
    private ai: AIRouter,
    private azdo: AzDoClient,
    opts?: { maxQuestionRounds?: number; integrationId?: string | null; target?: WorkflowTarget },
  ) {
    this.maxQuestionRounds = opts?.maxQuestionRounds ?? DEFAULT_MAX_QUESTION_ROUNDS;
    this.integrationId = opts?.integrationId ?? null;
    this.target = opts?.target ?? new TicketWorkflowTarget(db);
  }

  /** Build a where filter for DevOpsSyncState scoped by workItemId + integrationId. */
  private syncWhere(workItemId: number) {
    return { workItemId, integrationId: this.integrationId } as const;
  }

  /**
   * Called when a brand-new entity (ticket or operational task) is created from an actionable work item.
   * Kicks off the initial AI analysis.
   */
  async onNewEntity(entityId: string, workItemId: number): Promise<void> {
    if (this.processing.has(workItemId)) {
      logger.info({ workItemId }, 'Already processing this work item — skipping');
      return;
    }
    this.processing.add(workItemId);
    try {
      appLog.info(`New actionable entity — starting workflow`, { entityId, workItemId }, entityId, this.target.entityType);
      const ok = await this.transitionTo(workItemId, WorkflowState.ANALYZING, WorkflowState.IDLE);
      if (!ok) return;
      await this.runAnalysis(entityId, workItemId);
    } finally {
      this.processing.delete(workItemId);
    }
  }

  /**
   * Called on each poll cycle when an existing actionable entity is updated.
   * Uses an in-process lock and CAS state transitions to prevent concurrent processing.
   */
  async onEntityUpdate(entityId: string, workItemId: number): Promise<void> {
    if (this.processing.has(workItemId)) {
      logger.info({ workItemId }, 'Already processing this work item — skipping');
      return;
    }
    this.processing.add(workItemId);

    const syncState = await this.db.devOpsSyncState.findFirst({
      where: this.syncWhere(workItemId),
    });
    if (!syncState) {
      this.processing.delete(workItemId);
      return;
    }

    const rawState = syncState.workflowState;
    if (!isWorkflowState(rawState)) {
      logger.error({ workItemId, rawState }, 'Unknown workflow state — skipping');
      this.processing.delete(workItemId);
      return;
    }
    const state: WorkflowState = rawState;

    appLog.info(`Workflow update — current state: ${state}`, { entityId, workItemId, state }, entityId, this.target.entityType);
    try {
      switch (state) {
        case WorkflowState.IDLE: {
          appLog.info('Entity became actionable — starting analysis', { entityId, workItemId }, entityId, this.target.entityType);
          const ok = await this.transitionTo(workItemId, WorkflowState.ANALYZING, WorkflowState.IDLE);
          if (ok) await this.runAnalysis(entityId, workItemId);
          break;
        }

        case WorkflowState.ANALYZING:
          appLog.info('Analysis in progress — skipping', { entityId, workItemId }, entityId, this.target.entityType);
          break;

        case WorkflowState.QUESTIONING:
          appLog.info('Checking for new inbound comments', { entityId, workItemId }, entityId, this.target.entityType);
          await this.processAnswers(entityId, workItemId);
          break;

        case WorkflowState.PLANNING:
          appLog.info('Plan generation in progress — skipping', { entityId, workItemId }, entityId, this.target.entityType);
          break;

        case WorkflowState.AWAITING_APPROVAL:
          appLog.info('Checking for plan approval', { entityId, workItemId }, entityId, this.target.entityType);
          await this.checkApproval(entityId, workItemId);
          break;

        case WorkflowState.EXECUTING:
          appLog.info('Execution in progress — skipping', { entityId, workItemId }, entityId, this.target.entityType);
          break;

        case WorkflowState.COMPLETED:
          appLog.info('Workflow already completed — skipping', { entityId, workItemId }, entityId, this.target.entityType);
          break;
      }
    } finally {
      this.processing.delete(workItemId);
    }
  }

  /**
   * Run the initial AI analysis of a work item.
   * Posts analysis + questions as a comment on the DevOps work item.
   */
  private async runAnalysis(entityId: string, workItemId: number): Promise<void> {
    const context = await this.target.gatherContext(entityId);

    try {
      const response = await this.ai.generate({
        taskType: TaskType.ANALYZE_WORK_ITEM,
        context: { entityId, entityType: this.target.entityType, ...(context.clientId ? { clientId: context.clientId } : {}) },
        promptKey: 'devops.analyze.system',
        prompt: buildAnalysisPrompt(context),
      });

      // Post to DevOps
      const commentBody = `${BOT_MARKER}\n\n${response.content}`;
      await this.azdo.addComment(workItemId, commentBody);

      // Record as outbound event
      await this.target.createEvent(entityId, {
        eventType: 'DEVOPS_OUTBOUND',
        content: response.content,
        metadata: {
          workItemId,
          provider: response.provider,
          model: response.model,
          tokens: response.usage,
        },
        actor: 'ai:workflow',
      });

      // Transition to questioning — AI likely asked questions in its response
      await this.transitionTo(workItemId, WorkflowState.QUESTIONING, WorkflowState.ANALYZING);

      logger.info({ entityId, workItemId }, 'Initial analysis posted');
    } catch (error) {
      logger.error({ entityId, workItemId, error }, 'Failed to run initial analysis');
      // Roll back to idle so next poll cycle can retry
      await this.transitionTo(workItemId, WorkflowState.IDLE, WorkflowState.ANALYZING).catch((e) => {
        logger.error({ workItemId, error: e }, 'Failed to roll back state after analysis error');
      });
    }
  }

  /**
   * Process new answers from the user and decide next steps.
   */
  private async processAnswers(entityId: string, workItemId: number): Promise<void> {
    // Get the latest inbound comments since our last outbound
    const recentEvents = await this.target.getRecentEvents(entityId, 20);

    // Find the most recent outbound (our last message)
    const lastOutbound = recentEvents.find(
      (e) => e.eventType === 'DEVOPS_OUTBOUND' || e.eventType === 'PLAN_PROPOSED',
    );

    // Find inbound messages after our last outbound
    const newInbound = recentEvents.filter(
      (e) =>
        e.eventType === 'DEVOPS_INBOUND' &&
        (!lastOutbound || e.createdAt > lastOutbound.createdAt),
    );

    if (newInbound.length === 0) {
      appLog.info('No new inbound comments found — waiting', { entityId, workItemId, totalEvents: recentEvents.length }, entityId, this.target.entityType);
      return;
    }

    appLog.info(`Found ${newInbound.length} new inbound comment(s)`, {
      entityId, workItemId,
      inboundActors: newInbound.map((e) => e.actor),
      inboundSnippets: newInbound.map((e) => (e.content ?? '').slice(0, 100)),
    }, entityId, this.target.entityType);

    // Check if we've exceeded the maximum question rounds
    const outboundCount = recentEvents.filter((e) => e.eventType === 'DEVOPS_OUTBOUND').length;
    const forceReady = outboundCount >= this.maxQuestionRounds;

    if (forceReady) {
      appLog.info(`Max question rounds (${this.maxQuestionRounds}) reached — forcing plan generation`, { entityId, workItemId, outboundCount }, entityId, this.target.entityType);
    }

    const context = await this.target.gatherContext(entityId);

    try {
      const response = await this.ai.generate({
        taskType: TaskType.ANALYZE_WORK_ITEM,
        context: { entityId, entityType: this.target.entityType, ...(context.clientId ? { clientId: context.clientId } : {}) },
        promptKey: forceReady ? 'devops.force-plan.system' : 'devops.followup.system',
        prompt: buildFollowupPrompt(context),
      });

      // Check if the AI decided it has enough info to create a plan.
      // Accept the marker at the start of the response or on its own line (e.g. after
      // a preamble sentence the LLM sometimes emits before the marker).
      const readyToPlan = forceReady || hasReadyToPlanMarker(response.content);

      if (readyToPlan) {
        // Strip the marker and generate a plan
        const ok = await this.transitionTo(workItemId, WorkflowState.PLANNING, WorkflowState.QUESTIONING);
        if (ok) await this.generatePlan(entityId, workItemId);
      } else {
        // Post follow-up questions
        const commentBody = `${BOT_MARKER}\n\n${response.content}`;
        await this.azdo.addComment(workItemId, commentBody);

        await this.target.createEvent(entityId, {
          eventType: 'DEVOPS_OUTBOUND',
          content: response.content,
          metadata: { workItemId, provider: response.provider, model: response.model },
          actor: 'ai:workflow',
        });

        logger.info({ entityId, workItemId }, 'Follow-up questions posted');
      }
    } catch (error) {
      logger.error({ entityId, workItemId, error }, 'Failed to process answers');
      // Record the error so it's visible in the event log; stay in QUESTIONING for retry
      await this.target.createEvent(entityId, {
        eventType: 'SYSTEM_NOTE',
        content: `Failed to process answers: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { workItemId },
        actor: 'ai:workflow',
      }).catch(() => {});
    }
  }

  /**
   * Generate a structured execution plan and post it for approval.
   */
  private async generatePlan(entityId: string, workItemId: number): Promise<void> {
    const context = await this.target.gatherContext(entityId);

    try {
      const response = await this.ai.generate({
        taskType: TaskType.GENERATE_DEVOPS_PLAN,
        context: { entityId, entityType: this.target.entityType, ...(context.clientId ? { clientId: context.clientId } : {}) },
        promptKey: 'devops.plan.system',
        prompt: buildPlanPrompt(context),
      });

      // Try to extract JSON plan from the response
      const planSteps = extractPlanJson(response.content);

      if (!planSteps) {
        // AI didn't produce a valid plan — post the response and stay in planning
        // so the next cycle retries
        const commentBody = `${BOT_MARKER}\n\n${response.content}\n\n---\n*Could not extract a structured plan. Please provide more details or I'll retry.*`;
        await this.azdo.addComment(workItemId, commentBody);

        logger.warn({ entityId, workItemId }, 'Plan generation did not produce valid JSON, retrying');
        await this.transitionTo(workItemId, WorkflowState.QUESTIONING, WorkflowState.PLANNING);
        return;
      }

      // Store the plan in the sync state — bail out if the row is missing
      const syncForPlan = await this.db.devOpsSyncState.findFirst({
        where: this.syncWhere(workItemId),
        select: { id: true },
      });
      if (!syncForPlan) {
        logger.error({ entityId, workItemId }, 'DevOpsSyncState row missing — cannot persist plan');
        await this.transitionTo(workItemId, WorkflowState.QUESTIONING, WorkflowState.PLANNING).catch((e) => {
          logger.error({ workItemId, error: e }, 'Failed to roll back state after missing sync state');
        });
        return;
      }
      await this.db.devOpsSyncState.update({
        where: { id: syncForPlan.id },
        data: { planJson: JSON.parse(JSON.stringify(planSteps)) },
      });

      // Post plan to DevOps for approval
      const commentBody = `${BOT_MARKER}\n\n${response.content}\n\n---\n**To approve this plan, reply with "approved", "LGTM", or "go ahead".**\nTo request changes, describe what you'd like modified.`;
      await this.azdo.addComment(workItemId, commentBody);

      await this.target.createEvent(entityId, {
        eventType: 'PLAN_PROPOSED',
        content: response.content,
        metadata: {
          workItemId,
          planSteps,
          provider: response.provider,
          model: response.model,
        },
        actor: 'ai:workflow',
      });

      await this.transitionTo(workItemId, WorkflowState.AWAITING_APPROVAL, WorkflowState.PLANNING);
      logger.info({ entityId, workItemId, steps: planSteps.length }, 'Plan proposed');
    } catch (error) {
      logger.error({ entityId, workItemId, error }, 'Failed to generate plan');
      await this.transitionTo(workItemId, WorkflowState.QUESTIONING, WorkflowState.PLANNING).catch((e) => {
        logger.error({ workItemId, error: e }, 'Failed to roll back state after plan error');
      });
    }
  }

  /**
   * Check if the latest comment is an approval, rejection, or question about the plan.
   */
  private async checkApproval(entityId: string, workItemId: number): Promise<void> {
    const recentEvents = await this.target.getRecentEvents(entityId, 10);

    // Find the most recent outbound message (plan proposal or clarification response)
    const lastOutbound = recentEvents.find(
      (e) => e.eventType === 'PLAN_PROPOSED' || e.eventType === 'DEVOPS_OUTBOUND',
    );
    const newInbound = recentEvents.filter(
      (e) =>
        e.eventType === 'DEVOPS_INBOUND' &&
        lastOutbound &&
        e.createdAt > lastOutbound.createdAt,
    );

    if (newInbound.length === 0) {
      appLog.info('No new comments since last outbound — waiting for approval', { entityId, workItemId }, entityId, this.target.entityType);
      return;
    }

    const latestComment = newInbound[0];
    const commentText = latestComment.content ?? '';
    appLog.info(`New comment for plan approval check`, { entityId, workItemId, actor: latestComment.actor, commentSnippet: commentText.slice(0, 200) }, entityId, this.target.entityType);
    const intent = await this.classifyApproval(commentText);

    appLog.info(`Comment intent classified: ${intent}`, { entityId, workItemId, intent, commentText: commentText.slice(0, 200) }, entityId, this.target.entityType);
    logger.info({ entityId, workItemId, intent }, 'Comment intent classified');

    switch (intent) {
      case CommentIntent.APPROVED: {
        const ok = await this.transitionTo(workItemId, WorkflowState.EXECUTING, WorkflowState.AWAITING_APPROVAL);
        if (!ok) break;

        await this.target.createEvent(entityId, {
          eventType: 'PLAN_APPROVED',
          content: `Plan approved by ${latestComment.actor}`,
          metadata: { workItemId, approvalComment: latestComment.content },
          actor: latestComment.actor,
        });

        await this.executePlan(entityId, workItemId);
        break;
      }

      case CommentIntent.REJECTED: {
        const ok = await this.transitionTo(workItemId, WorkflowState.QUESTIONING, WorkflowState.AWAITING_APPROVAL);
        if (!ok) break;

        await this.target.createEvent(entityId, {
          eventType: 'PLAN_REJECTED',
          content: `Plan changes requested by ${latestComment.actor}`,
          metadata: { workItemId, rejectionComment: latestComment.content },
          actor: latestComment.actor,
        });

        // Acknowledge the rejection on DevOps so the user knows we're revisiting
        await this.azdo.addComment(
          workItemId,
          `${BOT_MARKER}\n\nUnderstood — I'll revisit the approach based on your feedback.`,
        );

        await this.processAnswers(entityId, workItemId);
        break;
      }

      case CommentIntent.NEEDS_CLARIFICATION: {
        await this.handleClarification(entityId, workItemId, commentText);
        break;
      }
    }
  }

  /**
   * Classify a user's comment as approval, rejection, or a question about the plan.
   * Uses the local LLM for classification. Falls back to regex if the LLM is unreachable.
   */
  private async classifyApproval(commentText: string): Promise<CommentIntent> {
    try {
      const response = await this.ai.generate({
        taskType: TaskType.CLASSIFY_INTENT,
        promptKey: 'devops.classify-approval.system',
        prompt: commentText,
      });

      const intent = extractClassificationToken(response.content);
      if (intent) return intent;

      logger.warn({ raw: response.content.trim() }, 'Unexpected classification response, falling back to regex');
      return classifyByRegex(commentText);
    } catch (error) {
      logger.warn({ error }, 'Classification LLM unreachable, falling back to regex');
      return classifyByRegex(commentText);
    }
  }

  /**
   * Handle a clarification question about the proposed plan.
   * Uses Claude to answer the question and stays in AWAITING_APPROVAL state.
   */
  private async handleClarification(
    entityId: string,
    workItemId: number,
    question: string,
  ): Promise<void> {
    const context = await this.target.gatherContext(entityId);

    try {
      const response = await this.ai.generate({
        taskType: TaskType.DRAFT_COMMENT,
        context: { entityId, entityType: this.target.entityType, ...(context.clientId ? { clientId: context.clientId } : {}) },
        promptKey: 'devops.clarify.system',
        prompt: buildClarificationPrompt(context, question),
      });

      const commentBody = `${BOT_MARKER}\n\n${response.content}`;
      await this.azdo.addComment(workItemId, commentBody);

      await this.target.createEvent(entityId, {
        eventType: 'DEVOPS_OUTBOUND',
        content: response.content,
        metadata: { workItemId, provider: response.provider, model: response.model },
        actor: 'ai:workflow',
      });

      // Stay in AWAITING_APPROVAL — user still needs to approve or reject
      logger.info({ entityId, workItemId }, 'Clarification response posted, awaiting approval');
    } catch (error) {
      logger.error({ entityId, workItemId, error }, 'Failed to handle clarification');
      await this.target.createEvent(entityId, {
        eventType: 'SYSTEM_NOTE',
        content: `Failed to handle clarification: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { workItemId },
        actor: 'ai:workflow',
      }).catch(() => {});
    }
  }

  /**
   * Execute the approved plan step by step, posting progress as comments.
   */
  private async executePlan(entityId: string, workItemId: number): Promise<void> {
    const syncState = await this.db.devOpsSyncState.findFirst({
      where: this.syncWhere(workItemId),
    });

    const planSteps = (syncState?.planJson as PlanStep[] | null) ?? [];

    if (planSteps.length === 0) {
      logger.warn({ entityId, workItemId }, 'No plan steps found — cannot execute');
      await this.azdo.addComment(
        workItemId,
        `${BOT_MARKER}\n\n**No plan steps found.** Returning to the planning phase to regenerate.`,
      );
      await this.transitionTo(workItemId, WorkflowState.PLANNING, WorkflowState.EXECUTING);
      return;
    }

    const context = await this.target.gatherContext(entityId);

    await this.target.createEvent(entityId, {
      eventType: 'PLAN_EXECUTING',
      content: `Executing plan with ${planSteps.length} steps`,
      metadata: { workItemId },
      actor: 'ai:workflow',
    });

    // Post execution start to DevOps
    await this.azdo.addComment(
      workItemId,
      `${BOT_MARKER}\n\n**Executing approved plan** (${planSteps.length} steps)...\n\nI'll post updates as each step completes.`,
    );

    try {
      // Execute each step with AI guidance
      const response = await this.ai.generate({
        taskType: TaskType.DRAFT_COMMENT,
        context: { entityId, entityType: this.target.entityType, ...(context.clientId ? { clientId: context.clientId } : {}) },
        promptKey: 'devops.execute.system',
        prompt: buildExecutionPrompt(context, planSteps),
      });

      // Post execution results
      const resultComment = `${BOT_MARKER}\n\n## Execution Results\n\n${response.content}`;
      await this.azdo.addComment(workItemId, resultComment);

      await this.target.createEvent(entityId, {
        eventType: 'PLAN_COMPLETED',
        content: response.content,
        metadata: {
          workItemId,
          provider: response.provider,
          model: response.model,
        },
        actor: 'ai:workflow',
      });

      // Flag for human verification instead of auto-resolving.
      // AI-generated execution results are not verified — require explicit
      // operator confirmation before marking as RESOLVED.
      await this.target.updateStatus(entityId, 'IN_PROGRESS');

      await this.target.createEvent(entityId, {
        eventType: 'SYSTEM_NOTE',
        content: 'Plan execution completed. Awaiting operator verification before resolving.',
        metadata: { workItemId, requiresVerification: true },
        actor: 'ai:workflow',
      });

      await this.transitionTo(workItemId, WorkflowState.COMPLETED, WorkflowState.EXECUTING);
      logger.info({ entityId, workItemId }, 'Plan execution completed — awaiting operator verification');
    } catch (error) {
      logger.error({ entityId, workItemId, error }, 'Plan execution failed');
      // Post failure notice to DevOps
      await this.azdo.addComment(
        workItemId,
        `${BOT_MARKER}\n\n**Execution failed.** An error occurred while executing the plan. The team has been notified.`,
      ).catch(() => {});
      // Record the error event
      await this.target.createEvent(entityId, {
        eventType: 'SYSTEM_NOTE',
        content: `Plan execution failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { workItemId },
        actor: 'ai:workflow',
      }).catch(() => {});
      // Stay in EXECUTING state — needs manual intervention
    }
  }

  /**
   * Atomically transition a work item's workflow state.
   * When `from` is specified, uses a compare-and-swap (CAS) pattern via `updateMany`
   * to prevent race conditions — the transition only succeeds if the current state
   * matches `from`. Returns false if the CAS check fails (state already changed).
   */
  private async transitionTo(workItemId: number, to: WorkflowState, from?: WorkflowState): Promise<boolean> {
    if (from) {
      const result = await this.db.devOpsSyncState.updateMany({
        where: { ...this.syncWhere(workItemId), workflowState: from },
        data: { workflowState: to },
      });
      if (result.count === 0) {
        logger.warn({ workItemId, from, to }, 'CAS transition failed — state already changed');
        return false;
      }
      // Fetch entity ID for logging after the atomic update
      const row = await this.db.devOpsSyncState.findFirst({ where: this.syncWhere(workItemId), select: { ticketId: true, operationalTaskId: true } });
      appLog.info(`Workflow transition: ${from} → ${to}`, { workItemId, from, to }, row?.ticketId ?? row?.operationalTaskId ?? undefined, row?.ticketId ? 'ticket' : row?.operationalTaskId ? 'operational_task' : undefined);
    } else {
      const current = await this.db.devOpsSyncState.findFirst({ where: this.syncWhere(workItemId), select: { id: true, workflowState: true, ticketId: true, operationalTaskId: true } });
      if (current) {
        await this.db.devOpsSyncState.update({
          where: { id: current.id },
          data: { workflowState: to },
        });
      }
      appLog.info(`Workflow transition: ${current?.workflowState ?? '?'} → ${to}`, { workItemId, from: current?.workflowState, to }, current?.ticketId ?? current?.operationalTaskId ?? undefined, current?.ticketId ? 'ticket' : current?.operationalTaskId ? 'operational_task' : undefined);
    }
    logger.info({ workItemId, state: to }, 'Workflow state transition');
    return true;
  }
}

// --- Approval detection ---

/**
 * Check if comment text represents an approval.
 * Requires the entire comment (after trimming) to be a short, unambiguous
 * approval phrase. Rejects text with negation, conditional, or change-request
 * language to avoid false positives like "yes, but change step 3" or
 * "go ahead and use a different approach".
 */
function checkApprovalText(text: string): boolean {
  // Reject anything over 80 chars — real approvals are short
  if (text.length > 80) return false;

  // Negative/rejection emojis anywhere in the text are treated as a hard rejection
  if (/[\u{1F44E}\u{274C}]/u.test(text)) return false;

  // Strip common positive emoji that don't change meaning for phrase matching
  const stripped = text.replace(/[\u{1F44D}\u{1F680}\u{2705}\u{1F389}]/gu, '').trim();

  // Pure emoji approvals (thumbs up, rocket, check mark, party)
  if (/^[\u{1F44D}\u{1F680}\u{2705}\u{1F389}\s]+$/u.test(text)) return true;

  // "+1" style approval
  if (/^\+1[.!]*$/.test(stripped)) return true;

  const negationPattern = /\b(?:not|don't|do not|doesn't|does not|can't|cannot|no(?!\s+(?:objections?|problems?|issues?|concerns?|complaints?|worries))|never|reject|decline|against|disagree|but|however|change|modify|instead|different|wait|stop|hold)\b/;
  if (negationPattern.test(stripped)) return false;

  // Require the full text to match an approval phrase (with optional trailing punctuation)
  const approvalPatterns = [
    /^(?:approved?|lgtm)[.!]*$/,
    /^(?:go ahead|looks good|proceed|execute|sounds good)[.!]*$/,
    /^(?:looks good,?\s*proceed|looks great)[.!]*$/,
    /^(?:ship it|do it|yes|yep|sure|ok|okay|yup|absolutely|definitely)[.!]*$/,
    /^(?:go for it|let's do it|let's go|perfect|fine by me)[.!]*$/,
    /^(?:i approve|i agree|no objections?|i have no objections?)[.!]*$/,
  ];

  return approvalPatterns.some((re) => re.test(stripped));
}

/** Check if comment text represents a rejection. Same strict approach as approvals. */
function checkRejectionText(text: string): boolean {
  if (text.length > 80) return false;

  // Positive/approval emojis anywhere in the text are treated as non-rejection
  if (/[\u{1F44D}\u{2705}\u{1F680}\u{1F389}]/u.test(text)) return false;

  // Strip negative emoji that don't change meaning for phrase matching
  const stripped = text.replace(/[\u{1F44E}\u{274C}]/gu, '').trim();

  // Pure thumbs-down or X emoji
  if (/^[\u{1F44E}\u{274C}\s]+$/u.test(text)) return true;

  // "-1" style rejection
  if (/^-1[.!]*$/.test(stripped)) return true;

  const rejectionPatterns = [
    /^(?:no|nope|reject(?:ed)?|denied|deny|decline(?:d)?)[.!]*$/,
    /^(?:don't do (?:this|that|it)|do not proceed|cancel)[.!]*$/,
    /^(?:thumbs down|absolutely not|negative)[.!]*$/,
    /^(?:start over|try again|redo(?: this)?|scrap (?:this|it))[.!]*$/,
  ];
  return rejectionPatterns.some((re) => re.test(stripped));
}

/** Regex-based fallback when LLM classification is unavailable. */
function classifyByRegex(commentText: string): CommentIntent {
  const normalized = commentText.toLowerCase().trim();
  if (checkApprovalText(normalized)) return CommentIntent.APPROVED;
  if (checkRejectionText(normalized)) return CommentIntent.REJECTED;
  return CommentIntent.NEEDS_CLARIFICATION;
}

// --- Context types ---

// --- Prompt builders ---
// System prompts are now resolved from the prompt registry (packages/ai-provider/src/prompts/devops.ts)
// via promptKey in each ai.generate() call — no longer duplicated here as inline constants.

function buildAnalysisPrompt(ctx: WorkflowContext): string {
  const lines = [
    `## Work Item: ${ctx.subject}`,
    ctx.clientName ? `**Client:** ${ctx.clientName}` : null,
    `**Priority:** ${ctx.priority}`,
    ctx.category ? `**Category:** ${ctx.category}` : null,
    '',
    '## Description',
    ctx.description ?? '(No description provided)',
    '',
    '## Event History',
  ];

  for (const event of ctx.events) {
    lines.push(`### ${event.type} (${event.actor}, ${event.createdAt})`);
    if (event.content) lines.push(event.content);
    lines.push('');
  }

  return lines.filter((l) => l !== null).join('\n');
}

function buildFollowupPrompt(ctx: WorkflowContext): string {
  return buildAnalysisPrompt(ctx) + '\n\nPlease review the full conversation above and decide: do you have enough information to create an execution plan, or do you need to ask more questions?';
}

function buildPlanPrompt(ctx: WorkflowContext): string {
  return buildAnalysisPrompt(ctx) + '\n\nBased on the full conversation above, create a detailed execution plan. Include the JSON plan block at the end.';
}

function buildExecutionPrompt(ctx: WorkflowContext, steps: PlanStep[]): string {
  const planStr = steps.length > 0
    ? steps.map((s) => `${s.step}. [${s.type}] ${s.description}\n   ${s.details}`).join('\n\n')
    : '(No structured plan available — use the conversation context)';

  return `${buildAnalysisPrompt(ctx)}\n\n## Approved Plan\n\n${planStr}\n\nExecute each step and report the results.`;
}

function buildClarificationPrompt(ctx: WorkflowContext, question: string): string {
  return `${buildAnalysisPrompt(ctx)}\n\n## User Question About the Plan\n\n${question}`;
}

/**
 * Check whether the AI response contains the [READY_TO_PLAN] marker.
 * Accepts the marker at the very start of the response, or on its own line
 * anywhere in the first 500 characters (LLMs sometimes emit a short preamble
 * sentence before the marker).
 *
 * Handles common LLM variations:
 * - `[READY_TO_PLAN]` (canonical)
 * - `[READY TO PLAN]` (spaces instead of underscores)
 * - `READY_TO_PLAN` (missing brackets)
 * - `**[READY_TO_PLAN]**` (bold markdown wrapping)
 */
function hasReadyToPlanMarker(content: string): boolean {
  const head = content.slice(0, 500);
  // Accept the marker on its own line with optional markdown bold/italic wrapping,
  // brackets, and underscore-vs-space variations.
  return /^\s*(?:\*{1,2})?\[?\s*READY[_ ]TO[_ ]PLAN\s*\]?(?:\*{1,2})?\s*$/im.test(head);
}

/**
 * Extract a classification intent token from an AI response.
 * Matches the first recognised token (APPROVED, REJECTED, NEEDS_CLARIFICATION)
 * that appears as a standalone word — prevents false positives from tokens
 * embedded inside longer words or followed by qualifiers on the same line.
 *
 * Handles common LLM output variations:
 * - Token on its own line: "APPROVED"
 * - Token with punctuation: "APPROVED."
 * - Token with markdown bold: "**APPROVED**"
 * - Token with prefix label: "Classification: APPROVED"
 * - Token with backticks: "`APPROVED`"
 */
function extractClassificationToken(content: string): CommentIntent | null {
  // Normalise: take only the first non-empty line, uppercase, strip markdown
  const firstLine = content.trim().split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const cleaned = firstLine.trim()
    .replace(/^(?:classification|intent|result|answer)\s*[:=\-]\s*/i, '') // strip prefix labels first
    .replace(/[*`]/g, '') // strip all markdown bold/code characters
    .trim()
    .toUpperCase();

  // Require the token to be the entire cleaned line (with optional trailing punctuation)
  if (/^APPROVED[.!:]*$/.test(cleaned)) return CommentIntent.APPROVED;
  if (/^REJECTED[.!:]*$/.test(cleaned)) return CommentIntent.REJECTED;
  if (/^NEEDS_CLARIFICATION[.!:]*$/.test(cleaned)) return CommentIntent.NEEDS_CLARIFICATION;

  // Fallback: scan the first 3 lines for a standalone token (LLMs sometimes add an
  // explanation line before/after the classification token)
  const lines = content.trim().split(/\r?\n/).slice(0, 3);
  for (const line of lines) {
    const stripped = line.trim().replace(/^[\s*`]+|[\s*`.!:]+$/g, '').toUpperCase();
    if (stripped === 'APPROVED') return CommentIntent.APPROVED;
    if (stripped === 'REJECTED') return CommentIntent.REJECTED;
    if (stripped === 'NEEDS_CLARIFICATION') return CommentIntent.NEEDS_CLARIFICATION;
  }

  return null;
}

const VALID_STEP_TYPES = new Set(['analysis', 'sql', 'code', 'manual', 'verification']);

/**
 * Validate that a parsed value is a well-formed PlanStep.
 */
function isValidPlanStep(s: unknown): s is PlanStep {
  if (typeof s !== 'object' || s === null) return false;
  const obj = s as Record<string, unknown>;
  return (
    typeof obj.step === 'number' &&
    typeof obj.description === 'string' &&
    typeof obj.type === 'string' &&
    VALID_STEP_TYPES.has(obj.type) &&
    typeof obj.details === 'string'
  );
}

/**
 * Try to extract a JSON plan array from an AI response.
 * Validates each step has the required fields and a valid type.
 *
 * Handles:
 * - Fenced code blocks (```json ... ``` and ``` ... ```)
 * - Multiple code blocks (tries each until one parses)
 * - Single JSON object (wraps it in an array)
 * - Bare JSON array in text
 * - Trailing commas, single-quoted strings, JS comments
 */
function extractPlanJson(content: string): PlanStep[] | null {
  // Try all ```json fences first, then plain ``` fences
  const fencedMatches = [
    ...content.matchAll(/```\s*json[\t\r\n ]*([\s\S]*?)```/gi),
    ...content.matchAll(/```[\t\r\n ]*([\s\S]*?)```/g),
  ];

  for (const match of fencedMatches) {
    const raw = match[1].trim();
    if (!raw) continue;

    // Try as array
    const result = tryParsePlanArray(raw);
    if (result) return result;

    // Try as single object → wrap in array
    const wrapped = tryParsePlanArray(`[${raw}]`);
    if (wrapped) return wrapped;
  }

  // Try to find bare JSON array(s) in the text.
  // Use a non-greedy global match and try each candidate, similar to fenced blocks.
  const arrayMatches = content.matchAll(/\[\s*\{[\s\S]*?\}\s*\]/g);
  for (const match of arrayMatches) {
    const result = tryParsePlanArray(match[0]);
    if (result) return result;
  }

  // Last resort: try to find a bare JSON object (single-step plan)
  const objectMatch = content.match(/\{\s*"step"\s*:[\s\S]*?\}/);
  if (objectMatch) {
    const result = tryParsePlanArray(`[${objectMatch[0]}]`);
    if (result) return result;
  }

  return null;
}

/**
 * Parse a JSON array string into PlanSteps, tolerating trailing commas,
 * single-quoted strings, and other common LLM JSON quirks.
 */
function tryParsePlanArray(raw: string): PlanStep[] | null {
  // First try strict JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Progressively clean common LLM JSON issues and retry:
    // 1. Strip trailing commas before ] or }
    // 2. Replace single-quoted strings with double-quoted (simple heuristic)
    // 3. Strip JavaScript-style comments
    let cleaned = raw
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/^\s*\/\/[^\n]*/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Try replacing single quotes around property values
      cleaned = cleaned.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every(isValidPlanStep)) return null;
  return parsed;
}
