import type { PrismaClient } from '@bronco/db';
import type { Mailer } from '@bronco/shared-utils';
import { createLogger, notifyOperators, getActiveOperatorRecords } from '@bronco/shared-utils';
import {
  AI_ACTION_TO_RECOMMENDATION,
  DEFAULT_ACTION_SAFETY_CONFIG,
  ActionSafetyLevel,
  isClosedStatus,
} from '@bronco/shared-types';
import type { ActionSafetyConfig, PendingActionStatus } from '@bronco/shared-types';
import { z } from 'zod';

const logger = createLogger('recommendation-executor');

const SETTINGS_KEY_ACTION_SAFETY = 'system-config-action-safety';

const VALID_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED']);
const VALID_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const VALID_CATEGORIES = new Set([
  'DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE',
  'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL',
]);

export interface ExecutorDeps {
  db: PrismaClient;
  mailer: Mailer | null;
}

export interface ParsedAction {
  action: string;
  value?: string;
  reason: string;
}

export interface ExecutionResult {
  action: string;
  recommendationType: string;
  value?: string;
  reason: string;
  outcome: 'auto_executed' | 'pending_approval' | 'skipped';
  pendingActionId?: string;
}

/** Zod schema for runtime validation of the stored ActionSafetyConfig. */
const actionSafetyConfigSchema = z.object({
  actions: z.record(z.string().min(1), z.enum(['auto', 'approval'])),
});

/** Load action safety config from AppSetting, merging with defaults on missing/malformed rows. */
async function loadSafetyConfig(db: PrismaClient): Promise<ActionSafetyConfig> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_ACTION_SAFETY } });
  if (!row) return DEFAULT_ACTION_SAFETY_CONFIG;

  const parsed = actionSafetyConfigSchema.safeParse(row.value);
  if (!parsed.success) {
    logger.warn(
      { key: SETTINGS_KEY_ACTION_SAFETY, errors: parsed.error.issues },
      'Action safety config is malformed — merging with defaults',
    );
    // Merge stored (potentially partial) raw value with defaults so known-good keys still win.
    const raw = (row.value as { actions?: unknown }).actions;
    const rawActions = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const VALID_LEVELS = new Set<string>(['auto', 'approval']);
    const mergedActions: Record<string, ActionSafetyLevel> = { ...DEFAULT_ACTION_SAFETY_CONFIG.actions };
    for (const [key, level] of Object.entries(rawActions)) {
      if (typeof level === 'string' && VALID_LEVELS.has(level)) {
        mergedActions[key] = level as ActionSafetyLevel;
      }
    }
    return { actions: mergedActions };
  }

  // Merge stored config on top of defaults so newly added action types always have a safety level.
  return {
    actions: {
      ...DEFAULT_ACTION_SAFETY_CONFIG.actions,
      ...(parsed.data.actions as Record<string, ActionSafetyLevel>),
    },
  };
}

/** Get safety level for an action type, defaulting unknown types to 'approval'. */
function getSafetyLevel(config: ActionSafetyConfig, actionType: string): ActionSafetyLevel {
  return (config.actions[actionType] as ActionSafetyLevel) ?? ActionSafetyLevel.APPROVAL;
}

/**
 * Execute AI recommendations based on the action safety configuration.
 * Auto-executes safe actions and queues risky ones as PendingAction rows.
 */
export async function executeRecommendations(
  deps: ExecutorDeps,
  ticketId: string,
  actions: ParsedAction[],
): Promise<ExecutionResult[]> {
  const { db, mailer } = deps;
  const config = await loadSafetyConfig(db);
  const results: ExecutionResult[] = [];

  // Load current ticket state
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { status: true, priority: true, category: true, assignedOperatorId: true },
  });
  if (!ticket) {
    logger.warn({ ticketId }, 'Ticket not found — skipping recommendation execution');
    return results;
  }

  // Track local state for sequential updates
  let currentStatus: string = ticket.status;
  let currentPriority: string = ticket.priority;
  let currentCategory: string | null = ticket.category;

  for (const action of actions.slice(0, 5)) {
    const recType = AI_ACTION_TO_RECOMMENDATION[action.action] ?? action.action;
    const safetyLevel = getSafetyLevel(config, recType);
    const isKnown = recType in config.actions;

    // If unknown action type, notify operators
    if (!isKnown) {
      logger.info({ ticketId, actionType: recType }, 'Unknown action type — defaulting to approval');
      await notifyUnknownActionType(deps, ticketId, recType, action.reason);
    }

    if (safetyLevel === ActionSafetyLevel.AUTO) {
      const executed = await autoExecute(db, ticketId, action, {
        currentStatus,
        currentPriority,
        currentCategory,
      });

      if (executed.statusUpdate) currentStatus = executed.statusUpdate;
      if (executed.priorityUpdate) currentPriority = executed.priorityUpdate;
      if (executed.categoryUpdate) currentCategory = executed.categoryUpdate;

      results.push({
        action: action.action,
        recommendationType: recType,
        value: action.value,
        reason: action.reason,
        outcome: executed.applied ? 'auto_executed' : 'skipped',
      });
    } else {
      // Create PendingAction for approval
      const pending = await db.pendingAction.create({
        data: {
          ticketId,
          actionType: recType,
          value: { action: action.action, value: action.value, reason: action.reason },
          status: 'pending',
          source: 'ai_recommendation',
        },
      });

      results.push({
        action: action.action,
        recommendationType: recType,
        value: action.value,
        reason: action.reason,
        outcome: 'pending_approval',
        pendingActionId: pending.id,
      });
    }
  }

  return results;
}

interface AutoExecState {
  currentStatus: string;
  currentPriority: string;
  currentCategory: string | null;
}

interface AutoExecResult {
  applied: boolean;
  statusUpdate?: string;
  priorityUpdate?: string;
  categoryUpdate?: string;
}

async function autoExecute(
  db: PrismaClient,
  ticketId: string,
  action: ParsedAction,
  state: AutoExecState,
): Promise<AutoExecResult> {
  const rawValue = action.value?.trim();
  const value = rawValue?.toUpperCase();

  try {
    switch (action.action) {
      case 'set_status': {
        if (!value || !VALID_STATUSES.has(value)) return { applied: false };
        if (value === state.currentStatus) return { applied: false };
        await db.ticket.update({
          where: { id: ticketId },
          data: {
            status: value as 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'RESOLVED' | 'CLOSED',
            resolvedAt: isClosedStatus(value) ? new Date() : null,
          },
        });
        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'STATUS_CHANGE',
            content: `Auto-executed: status changed to ${value} — ${action.reason}`,
            metadata: { previousStatus: state.currentStatus, newStatus: value, triggeredBy: 'ai_recommendation', recommendationSource: 'SUGGEST_NEXT_STEPS' },
            actor: 'system:recommendation-executor',
          },
        });
        logger.info({ ticketId, from: state.currentStatus, to: value }, 'Auto-executed status change');
        return { applied: true, statusUpdate: value };
      }

      case 'set_priority': {
        if (!value || !VALID_PRIORITIES.has(value)) return { applied: false };
        if (value === state.currentPriority) return { applied: false };
        await db.ticket.update({
          where: { id: ticketId },
          data: { priority: value as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' },
        });
        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'PRIORITY_CHANGE',
            content: `Auto-executed: priority changed to ${value} — ${action.reason}`,
            metadata: { previousPriority: state.currentPriority, newPriority: value, triggeredBy: 'ai_recommendation', recommendationSource: 'SUGGEST_NEXT_STEPS' },
            actor: 'system:recommendation-executor',
          },
        });
        logger.info({ ticketId, from: state.currentPriority, to: value }, 'Auto-executed priority change');
        return { applied: true, priorityUpdate: value };
      }

      case 'set_category': {
        if (!value || !VALID_CATEGORIES.has(value)) return { applied: false };
        if (value === state.currentCategory) return { applied: false };
        await db.ticket.update({
          where: { id: ticketId },
          data: { category: value as 'DATABASE_PERF' | 'BUG_FIX' | 'FEATURE_REQUEST' | 'SCHEMA_CHANGE' | 'CODE_REVIEW' | 'ARCHITECTURE' | 'GENERAL' },
        });
        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'CATEGORY_CHANGE',
            content: `Auto-executed: category changed to ${value} — ${action.reason}`,
            metadata: { previousCategory: state.currentCategory, newCategory: value, triggeredBy: 'ai_recommendation', recommendationSource: 'SUGGEST_NEXT_STEPS' },
            actor: 'system:recommendation-executor',
          },
        });
        logger.info({ ticketId, from: state.currentCategory, to: value }, 'Auto-executed category change');
        return { applied: true, categoryUpdate: value };
      }

      case 'add_comment': {
        const text = action.value ?? action.reason;
        if (!text) return { applied: false };
        await db.ticketEvent.create({
          data: {
            ticketId,
            eventType: 'COMMENT',
            content: text,
            metadata: { triggeredBy: 'ai_recommendation', recommendationSource: 'SUGGEST_NEXT_STEPS' },
            actor: 'system:recommendation-executor',
          },
        });
        logger.info({ ticketId }, 'Auto-executed: added comment');
        return { applied: true };
      }

      default:
        return { applied: false };
    }
  } catch (err) {
    logger.error({ err, ticketId, action: action.action }, 'Failed to auto-execute action');
    return { applied: false };
  }
}

/** Notify operators about an unknown action type so they can classify it in settings. */
async function notifyUnknownActionType(
  deps: ExecutorDeps,
  ticketId: string,
  actionType: string,
  reason: string,
): Promise<void> {
  if (!deps.mailer) return;
  try {
    await notifyOperators(
      deps.mailer,
      () => getActiveOperatorRecords(deps.db),
      {
        subject: `[Bronco] Unknown AI action type: ${actionType}`,
        body: [
          `The AI recommendation engine produced an action type that is not configured in the action safety settings.`,
          '',
          `Action type: ${actionType}`,
          `Ticket: ${ticketId}`,
          `Reason: ${reason}`,
          '',
          `This action has been queued for approval. To configure it, go to Settings → Action Safety.`,
        ].join('\n'),
      },
    );
  } catch (err) {
    logger.warn({ err, ticketId, actionType }, 'Failed to notify operators about unknown action type');
  }
}

/**
 * Reverse-lookup map: RecommendationActionType → first matching AI action name.
 * Used when `pendingAction.value.action` is absent (e.g. legacy or manually created rows)
 * so that `autoExecute` receives the AI action name it switches on (e.g. "set_status").
 */
const RECOMMENDATION_TO_AI_ACTION: Record<string, string> = Object.fromEntries(
  Object.entries(AI_ACTION_TO_RECOMMENDATION).map(([aiAction, recType]) => [recType, aiAction]),
);

/**
 * Execute a single pending action after operator approval.
 * Called from the copilot-api when an operator approves a pending action.
 */
export async function executePendingAction(
  db: PrismaClient,
  pendingAction: { id: string; ticketId: string; actionType: string; value: Record<string, unknown> },
): Promise<boolean> {
  // Prefer the AI action name stored in the value payload (set at creation time).
  // Fall back to reverse-mapping the actionType through AI_ACTION_TO_RECOMMENDATION so that
  // autoExecute receives a recognised action name (e.g. "set_status") rather than the
  // recommendation type (e.g. "change_status"), which has no case in the switch.
  const storedAction = pendingAction.value.action as string | undefined;
  const resolvedAction = storedAction ?? RECOMMENDATION_TO_AI_ACTION[pendingAction.actionType] ?? pendingAction.actionType;

  const action: ParsedAction = {
    action: resolvedAction,
    value: pendingAction.value.value as string | undefined,
    reason: (pendingAction.value.reason as string) ?? 'Operator-approved action',
  };

  const ticket = await db.ticket.findUnique({
    where: { id: pendingAction.ticketId },
    select: { status: true, priority: true, category: true },
  });
  if (!ticket) return false;

  const result = await autoExecute(db, pendingAction.ticketId, action, {
    currentStatus: ticket.status,
    currentPriority: ticket.priority,
    currentCategory: ticket.category,
  });

  return result.applied;
}
