import type { PrismaClient } from '@bronco/db';
import type { Queue } from 'bullmq';
import type { SlackClient, SlackBlockAction, SlackThreadMessage, SlackMentionEvent, SlackDirectMessageEvent } from '@bronco/shared-utils';
import { createLogger } from '@bronco/shared-utils';
import { lookupThread, storeThread } from './slack-thread-store.js';
import type { SlackThreadEntry } from './slack-thread-store.js';

const logger = createLogger('slack-action-handler');

interface IssueResolvePayload {
  issueJobId: string;
  resume?: boolean;
  regenerateFeedback?: string;
}

export interface SlackActionHandlerDeps {
  db: PrismaClient;
  slack: SlackClient;
  issueResolveQueue: Queue;
}

/**
 * Resolve a Slack user ID to an active Operator.
 * Returns null if the user is not a registered/active operator.
 */
async function resolveOperator(db: PrismaClient, slackUserId: string) {
  const row = await db.operator.findFirst({
    where: { slackUserId, person: { isActive: true } },
    select: { id: true, person: { select: { name: true, email: true } } },
  });
  return row ? { id: row.id, name: row.person.name, email: row.person.email } : null;
}

/**
 * Replace the original message's action buttons with a status line.
 */
async function replaceButtonsWithStatus(
  slack: SlackClient,
  channelId: string,
  messageTs: string,
  originalText: string,
  statusLine: string,
): Promise<void> {
  try {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: originalText } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: statusLine }] },
    ];
    await slack.updateMessage(channelId, messageTs, originalText, blocks);
  } catch (err) {
    logger.warn({ err, channelId, messageTs }, 'Failed to update Slack message after action');
  }
}

/**
 * Get the summary text from the original plan message for updating after action.
 */
async function getPlanSummaryText(db: PrismaClient, issueJobId: string): Promise<string> {
  const job = await db.issueJob.findUnique({
    where: { id: issueJobId },
    select: {
      branchName: true,
      planRevision: true,
      ticket: { select: { subject: true } },
      plan: true,
    },
  });
  if (!job) return 'Resolution plan';

  const plan = job.plan as Record<string, unknown> | null;
  const summary = (plan?.summary as string) ?? '';
  const revTag = (job.planRevision ?? 0) > 1 ? ` (rev ${job.planRevision})` : '';
  return `*Resolution Plan${revTag}: ${job.ticket.subject}*\nBranch: \`${job.branchName}\`\n\n*Summary:* ${summary}`;
}

async function handlePlanApprove(
  deps: SlackActionHandlerDeps,
  action: SlackBlockAction,
): Promise<void> {
  const { db, slack, issueResolveQueue } = deps;
  const issueJobId = action.value;

  const operator = await resolveOperator(db, action.userId);
  if (!operator) {
    await slack.replyInThread(action.channelId, action.messageTs, "You're not a registered operator — action ignored.");
    return;
  }

  // Check job is still in AWAITING_APPROVAL
  const job = await db.issueJob.findUnique({
    where: { id: issueJobId },
    select: { id: true, status: true, plan: true, ticketId: true },
  });

  if (!job) {
    await slack.replyInThread(action.channelId, action.messageTs, 'Issue job not found.');
    return;
  }

  if (job.status !== 'AWAITING_APPROVAL') {
    await slack.replyInThread(action.channelId, action.messageTs, `Job is no longer awaiting approval (current status: ${job.status}).`);
    return;
  }

  // Record approval but leave status as AWAITING_APPROVAL — the worker handles
  // the state transition to CLONING when it picks up the resume job.
  const updated = await db.issueJob.updateMany({
    where: { id: issueJobId, status: 'AWAITING_APPROVAL' },
    data: {
      approvedAt: new Date(),
      approvedBy: operator.name,
      approvedByOperatorId: operator.id,
    },
  });

  if (updated.count === 0) {
    await slack.replyInThread(action.channelId, action.messageTs, 'Job was already approved or rejected by someone else.');
    return;
  }

  // Create audit event
  await db.ticketEvent.create({
    data: {
      ticketId: job.ticketId,
      eventType: 'PLAN_APPROVED',
      content: `Plan approved by ${operator.name} via Slack`,
      metadata: { issueJobId, approvedBy: operator.name, approvedByOperatorId: operator.id, source: 'slack' },
      actor: operator.name,
    },
  });

  // Enqueue resume job
  await issueResolveQueue.add('resolve-issue', {
    issueJobId,
    resume: true,
  } satisfies IssueResolvePayload, {
    jobId: `resume-${issueJobId}`,
  });

  // Replace buttons with status line
  const summaryText = await getPlanSummaryText(db, issueJobId);
  await replaceButtonsWithStatus(
    slack,
    action.channelId,
    action.messageTs,
    summaryText,
    `:white_check_mark: *Approved* by ${operator.name}`,
  );

  logger.info({ issueJobId, operatorId: operator.id }, 'Plan approved via Slack');
}

async function handlePlanReject(
  deps: SlackActionHandlerDeps,
  action: SlackBlockAction,
): Promise<void> {
  const { db, slack } = deps;
  const issueJobId = action.value;

  const operator = await resolveOperator(db, action.userId);
  if (!operator) {
    await slack.replyInThread(action.channelId, action.messageTs, "You're not a registered operator — action ignored.");
    return;
  }

  // Check job is still in AWAITING_APPROVAL
  const job = await db.issueJob.findUnique({
    where: { id: issueJobId },
    select: { id: true, status: true },
  });

  if (!job || job.status !== 'AWAITING_APPROVAL') {
    await slack.replyInThread(action.channelId, action.messageTs, 'Job is no longer awaiting approval.');
    return;
  }

  // Open a modal to collect rejection feedback
  if (!action.triggerId) {
    // Fallback: ask in thread if no triggerId
    await slack.replyInThread(action.channelId, action.messageTs, 'Please reply in this thread with your rejection feedback.');
    return;
  }

  await slack.openModal(action.triggerId, {
    type: 'modal',
    callback_id: `plan_reject_modal_${issueJobId}`,
    title: { type: 'plain_text', text: 'Reject Plan' },
    submit: { type: 'plain_text', text: 'Reject' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reject_feedback_block',
        element: {
          type: 'plain_text_input',
          action_id: 'reject_feedback_input',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'What should be changed in the plan?' },
        },
        label: { type: 'plain_text', text: 'Feedback' },
      },
    ],
    // Store metadata for the view_submission handler
    private_metadata: JSON.stringify({
      channelId: action.channelId,
      messageTs: action.messageTs,
    }),
  });
}

async function handlePlanRejectConfirmed(
  deps: SlackActionHandlerDeps,
  action: SlackBlockAction,
): Promise<void> {
  const { db, slack, issueResolveQueue } = deps;

  let parsed: { jobId: string; feedback: string };
  try {
    parsed = JSON.parse(action.value);
  } catch {
    logger.warn({ value: action.value }, 'Invalid plan_reject_confirmed payload');
    return;
  }

  const { jobId: issueJobId, feedback } = parsed;

  const operator = await resolveOperator(db, action.userId);
  if (!operator) return;

  // Atomic transition to PLANNING
  const updated = await db.issueJob.updateMany({
    where: { id: issueJobId, status: 'AWAITING_APPROVAL' },
    data: {
      status: 'PLANNING',
      approvedAt: null,
      approvedBy: null,
      approvedByOperatorId: null,
    },
  });

  if (updated.count === 0) {
    logger.info({ issueJobId }, 'Reject confirmed but job already transitioned');
    return;
  }

  // Enqueue regeneration job
  await issueResolveQueue.add('resolve-issue', {
    issueJobId,
    regenerateFeedback: feedback.trim(),
  } satisfies IssueResolvePayload);

  // Try to update the original message if we have metadata
  const job = await db.issueJob.findUnique({
    where: { id: issueJobId },
    select: { metadata: true },
  });
  const meta = (job?.metadata as Record<string, unknown>) ?? {};
  const notifications = meta.slackNotifications as Array<{ channelId: string; ts: string }> | undefined;
  if (notifications?.length) {
    for (const notif of notifications) {
      const summaryText = await getPlanSummaryText(db, issueJobId);
      await replaceButtonsWithStatus(
        slack,
        notif.channelId,
        notif.ts,
        summaryText,
        `:x: *Rejected* by ${operator.name} — regenerating plan`,
      );
    }
  }

  logger.info({ issueJobId, operatorId: operator.id }, 'Plan rejected via Slack modal');
}

async function handlePlanDetail(
  deps: SlackActionHandlerDeps,
  action: SlackBlockAction,
): Promise<void> {
  const { db, slack } = deps;
  const issueJobId = action.value;

  const operator = await resolveOperator(db, action.userId);
  if (!operator) {
    await slack.replyInThread(action.channelId, action.messageTs, "You're not a registered operator — action ignored.");
    return;
  }

  const job = await db.issueJob.findUnique({
    where: { id: issueJobId },
    select: {
      plan: true,
      planRevision: true,
      branchName: true,
      ticket: { select: { subject: true } },
    },
  });

  if (!job?.plan) {
    await slack.replyInThread(action.channelId, action.messageTs, 'No plan details available.');
    return;
  }

  const plan = job.plan as Record<string, unknown>;
  const actions = (plan.actions as Array<Record<string, unknown>>) ?? [];

  const lines: string[] = [];
  lines.push(`*Detailed Plan for: ${job.ticket.subject}*`);
  lines.push(`Branch: \`${job.branchName}\` | Revision: ${job.planRevision}`);
  lines.push('');

  if (plan.approach) {
    lines.push(`*Approach:* ${plan.approach}`);
    lines.push('');
  }

  const willDo = actions.filter(a => a.category === 'WILL_DO');
  const canDoIfAllowed = actions.filter(a => a.category === 'CAN_DO_IF_ALLOWED');
  const cannotDo = actions.filter(a => a.category === 'CANNOT_DO');

  if (willDo.length > 0) {
    lines.push('*Will Do (automated on approval):*');
    for (const a of willDo) {
      lines.push(`• ${a.description}`);
      const files = a.files as string[] | undefined;
      if (files?.length) lines.push(`  _Files: ${files.join(', ')}_`);
    }
    lines.push('');
  }

  if (canDoIfAllowed.length > 0) {
    lines.push('*Can Do If Allowed:*');
    for (const a of canDoIfAllowed) {
      lines.push(`• ${a.description}`);
      if (a.requirement) lines.push(`  _Requires: ${a.requirement}_`);
    }
    lines.push('');
  }

  if (cannotDo.length > 0) {
    lines.push('*Cannot Do (manual steps required):*');
    for (const a of cannotDo) {
      lines.push(`• ${a.description}`);
      if (a.manualSteps) lines.push(`  _Manual: ${a.manualSteps}_`);
    }
    lines.push('');
  }

  const assumptions = (plan.assumptions as string[]) ?? [];
  if (assumptions.length > 0) {
    lines.push('*Assumptions:*');
    for (const a of assumptions) lines.push(`• ${a}`);
    lines.push('');
  }

  const openQuestions = (plan.openQuestions as string[]) ?? [];
  if (openQuestions.length > 0) {
    lines.push('*Open Questions:*');
    for (const q of openQuestions) lines.push(`• ${q}`);
    lines.push('');
  }

  lines.push(`_Estimated files to change: ${plan.estimatedFiles ?? 'unknown'}_`);

  await slack.replyInThread(action.channelId, action.messageTs, lines.join('\n'));
  logger.info({ issueJobId, operatorId: operator.id }, 'Plan detail sent via Slack thread');
}

async function handleTicketAssign(
  deps: SlackActionHandlerDeps,
  action: SlackBlockAction,
): Promise<void> {
  const { db, slack } = deps;
  const ticketId = action.value;

  const operator = await resolveOperator(db, action.userId);
  if (!operator) {
    await slack.replyInThread(action.channelId, action.messageTs, "You're not a registered operator — action ignored.");
    return;
  }

  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, subject: true, assignedOperatorId: true },
  });

  if (!ticket) {
    await slack.replyInThread(action.channelId, action.messageTs, 'Ticket not found.');
    return;
  }

  if (ticket.assignedOperatorId === operator.id) {
    await slack.replyInThread(action.channelId, action.messageTs, 'You are already assigned to this ticket.');
    return;
  }

  await db.ticket.update({
    where: { id: ticketId },
    data: { assignedOperatorId: operator.id },
  });

  await db.ticketEvent.create({
    data: {
      ticketId,
      eventType: 'ASSIGNMENT',
      content: `Assigned to ${operator.name} via Slack`,
      metadata: { operatorId: operator.id, source: 'slack' },
      actor: operator.name,
    },
  });

  await slack.replyInThread(action.channelId, action.messageTs, `:bust_in_silhouette: Ticket assigned to ${operator.name}`);
  logger.info({ ticketId, operatorId: operator.id }, 'Ticket assigned via Slack');
}

/**
 * Fallback: look up a Slack thread from DB metadata when the in-memory store has no entry.
 * Checks issueJob.metadata.slackNotifications for a matching channelId + ts,
 * then caches the result in the in-memory store for future lookups.
 */
async function lookupThreadFromDb(
  db: PrismaClient,
  channelId: string,
  threadTs: string,
): Promise<SlackThreadEntry | undefined> {
  try {
    // Search for issue jobs that have slackNotifications matching this thread
    const jobs = await db.issueJob.findMany({
      where: { metadata: { path: ['slackNotifications'], not: 'null' } },
      select: { id: true, ticketId: true, metadata: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    for (const job of jobs) {
      const meta = job.metadata as Record<string, unknown> | null;
      const notifications = meta?.slackNotifications as Array<{ channelId: string; ts: string }> | undefined;
      if (!notifications) continue;

      const match = notifications.find(n => n.channelId === channelId && n.ts === threadTs);
      if (match) {
        const entry: SlackThreadEntry = {
          ticketId: job.ticketId,
          channelId,
          context: 'plan_approval',
          issueJobId: job.id,
        };
        // Cache in in-memory store for future lookups
        storeThread(channelId, threadTs, entry);
        return entry;
      }
    }
  } catch (err) {
    logger.debug({ err, channelId, threadTs }, 'Failed to look up thread from DB metadata');
  }
  return undefined;
}

/**
 * Handle a threaded reply that maps back to a known ticket notification.
 * Creates a COMMENT ticket event.
 */
async function handleThreadedReply(
  deps: SlackActionHandlerDeps,
  message: SlackThreadMessage,
): Promise<void> {
  const { db, slack } = deps;

  let entry = lookupThread(message.channelId, message.threadTs);
  if (!entry) {
    // Fallback: check DB metadata for issue job Slack notifications
    entry = await lookupThreadFromDb(db, message.channelId, message.threadTs);
  }
  if (!entry) return; // Not a tracked thread — ignore silently

  const operator = await resolveOperator(db, message.userId);
  if (!operator) {
    // Ignore messages from non-operators silently
    return;
  }

  // Verify ticket still exists
  const ticket = await db.ticket.findUnique({
    where: { id: entry.ticketId },
    select: { id: true, status: true },
  });

  if (!ticket) {
    logger.debug({ ticketId: entry.ticketId }, 'Threaded reply for deleted ticket — ignoring');
    return;
  }

  // Create a COMMENT ticket event
  await db.ticketEvent.create({
    data: {
      ticketId: entry.ticketId,
      eventType: 'COMMENT',
      content: message.text,
      metadata: {
        source: 'slack',
        slackUserId: message.userId,
        operatorId: operator.id,
        operatorName: operator.name,
        slackChannelId: message.channelId,
        slackThreadTs: message.threadTs,
        slackMessageTs: message.ts,
      },
      actor: operator.name,
    },
  });

  // Confirm with a checkmark reaction
  await slack.addReaction(message.channelId, message.ts, 'white_check_mark');
  logger.info({ ticketId: entry.ticketId, operatorId: operator.id }, 'Slack thread reply captured as ticket comment');
}

/**
 * Create the block action handler that routes actions to the appropriate handler.
 */
export function createBlockActionHandler(deps: SlackActionHandlerDeps) {
  return async (action: SlackBlockAction): Promise<void> => {
    logger.info({ actionId: action.actionId, value: action.value, userId: action.userId }, 'Slack block action received');

    switch (action.actionId) {
      case 'plan_approve':
        await handlePlanApprove(deps, action);
        break;
      case 'plan_reject':
        await handlePlanReject(deps, action);
        break;
      case 'plan_reject_confirmed':
        await handlePlanRejectConfirmed(deps, action);
        break;
      case 'plan_detail':
        await handlePlanDetail(deps, action);
        break;
      case 'ticket_assign':
        await handleTicketAssign(deps, action);
        break;
      default:
        logger.debug({ actionId: action.actionId }, 'Unhandled Slack action');
    }
  };
}

/**
 * Create the thread message handler for capturing replies as ticket comments.
 */
export function createThreadMessageHandler(deps: SlackActionHandlerDeps) {
  return async (message: SlackThreadMessage): Promise<void> => {
    await handleThreadedReply(deps, message);
  };
}

/**
 * Create the mention handler for @mentions in channels.
 */
export function createMentionHandler(deps: SlackActionHandlerDeps) {
  return async (event: SlackMentionEvent): Promise<void> => {
    logger.info({ userId: event.userId, channelId: event.channelId }, 'Slack @mention received');
    await deps.slack.addReaction(event.channelId, event.ts, 'eyes');

    // Strip the bot mention from the text (Slack includes "<@BOT_ID> " prefix)
    const cleanText = event.text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();

    await deps.slack.replyInThread(
      event.channelId,
      event.ts,
      `Hi <@${event.userId}>! I received your message: "${cleanText}"\n\nI'm the Bronco support bot. I'll notify you here when tickets need attention, plans are ready for approval, or analysis is complete.`,
    );
  };
}

/**
 * Create the direct message handler for top-level DMs.
 */
export function createDirectMessageHandler(deps: SlackActionHandlerDeps) {
  return async (event: SlackDirectMessageEvent): Promise<void> => {
    logger.info({ userId: event.userId, channelId: event.channelId }, 'Slack DM received');
    await deps.slack.sendMessage(
      event.channelId,
      `Hi! I'm Hugo, the Bronco support bot. Here's what I can do:\n\n• Send you notifications when tickets need attention\n• Alert you when resolution plans are ready for approval\n• Share analysis findings and suggested next steps\n\nYou'll receive messages here automatically based on your notification preferences. You can also reply in notification threads to add comments to tickets.`,
    );
  };
}

/**
 * Build Block Kit blocks for a new ticket notification with contextual buttons.
 */
export function buildTicketNotificationBlocks(
  ticketId: string,
  subject: string,
  category: string,
  priority: string | null,
  panelBaseUrl?: string,
): unknown[] {
  const priorityEmoji = priority === 'CRITICAL' ? ':rotating_light:' :
    priority === 'HIGH' ? ':warning:' :
    priority === 'MEDIUM' ? ':large_blue_circle:' : ':white_circle:';

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${priorityEmoji} *New Ticket: ${subject}*\nCategory: \`${category}\`${priority ? ` | Priority: \`${priority}\`` : ''}`,
      },
    },
    {
      type: 'actions',
      block_id: `ticket_${ticketId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Assign to Me' },
          action_id: 'ticket_assign',
          value: ticketId,
        },
        ...(panelBaseUrl ? [{
          type: 'button',
          text: { type: 'plain_text', text: 'View in Panel' },
          action_id: 'ticket_view_panel',
          url: `${panelBaseUrl}/tickets/${ticketId}`,
        }] : []),
      ],
    },
  ];

  return blocks;
}

/**
 * Build Block Kit blocks for an analysis complete notification.
 */
export function buildAnalysisCompleteBlocks(
  ticketId: string,
  subject: string,
  summary: string | null,
  panelBaseUrl?: string,
): unknown[] {
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Analysis Complete: ${subject}*${summary ? `\n${summary}` : ''}`,
      },
    },
    {
      type: 'actions',
      block_id: `analysis_${ticketId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Assign to Me' },
          action_id: 'ticket_assign',
          value: ticketId,
        },
        ...(panelBaseUrl ? [{
          type: 'button',
          text: { type: 'plain_text', text: 'View in Panel' },
          action_id: 'ticket_view_panel',
          url: `${panelBaseUrl}/tickets/${ticketId}`,
        }] : []),
      ],
    },
  ];

  return blocks;
}
