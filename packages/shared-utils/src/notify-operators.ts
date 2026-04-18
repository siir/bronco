import { createLogger } from './logger.js';
import type { Mailer } from './mailer.js';
import type { SlackMessageResult } from './slack-client.js';

const logger = createLogger('notify-operators');

export interface OperatorRecord {
  id: string;
  email: string;
  name: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackUserId: string | null;
}

/**
 * Prisma-typed operators findMany loader used by {@link getActiveOperatorRecords}.
 * Declared as a structural interface so any service with a PrismaClient can
 * pass it in without a direct dependency on @bronco/db.
 */
export interface ActiveOperatorsLoader {
  operator: {
    findMany(args: {
      where: { person: { isActive: true } };
      include: { person: { select: { email: true; name: true } } };
    }): Promise<
      Array<{
        id: string;
        notifyEmail: boolean;
        notifySlack: boolean;
        slackUserId: string | null;
        person: { email: string; name: string };
      }>
    >;
  };
}

/**
 * Load active Operators and project them into {@link OperatorRecord} shape.
 * Bridge helper for #219 Wave 1 — prior callers queried `operator.isActive`
 * directly; the unified schema moved `isActive`/`email`/`name` to Person.
 * TODO(#219 Wave 2A): consider inlining at each call site or replacing with a
 * Prisma extension.
 */
export async function getActiveOperatorRecords(db: ActiveOperatorsLoader): Promise<OperatorRecord[]> {
  const rows = await db.operator.findMany({
    where: { person: { isActive: true } },
    include: { person: { select: { email: true, name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.person.email,
    name: r.person.name,
    notifyEmail: r.notifyEmail,
    notifySlack: r.notifySlack,
    slackUserId: r.slackUserId,
  }));
}

export interface SlackSender {
  sendDM(slackUserId: string, text: string, blocks?: unknown[]): Promise<void>;
  sendDMWithTs?(slackUserId: string, text: string, blocks?: unknown[]): Promise<SlackMessageResult>;
  sendMessage(channelId: string, text: string, blocks?: unknown[]): Promise<void>;
  sendMessageWithTs?(channelId: string, text: string, blocks?: unknown[]): Promise<SlackMessageResult>;
  isConnected(): boolean;
}

export interface NotificationPreference {
  event: string;
  emailEnabled: boolean;
  slackEnabled: boolean;
  slackTarget: string | null;
  emailTarget: string | null;
  isActive: boolean;
}

export interface NotifyOperatorsOpts {
  /** Subject line for the notification email. */
  subject: string;
  /** Plain-text body. */
  body: string;
  /** If provided, only notify this specific operator (e.g. the assigned operator). */
  operatorId?: string;
  /** Slack client for sending Slack notifications. */
  slack?: SlackSender;
  /** Default Slack channel ID (from System Settings) for operators without a slackUserId. */
  defaultSlackChannelId?: string;
  /** Optional Block Kit blocks for rich Slack messages. */
  slackBlocks?: unknown[];
  /** Notification event type — when provided, looks up preferences to control dispatch. */
  event?: string;
  /** Function to load the notification preference for the given event. */
  getPreference?: (event: string) => Promise<NotificationPreference | null>;
  /** When true, return a NotifyOperatorsResult instead of string[]. */
  returnResult?: boolean;
}

/** Result of a notification run, including Slack message metadata for thread tracking. */
export interface NotifyOperatorsResult {
  /** Email addresses that received notifications. */
  emailRecipients: string[];
  /** Slack message metadata for each successfully sent Slack message. */
  slackMessages: Array<SlackMessageResult & { operatorId?: string }>;
}

/**
 * Send a notification to operators based on event preferences.
 *
 * When `event` and `getPreference` are provided, dispatch is controlled by the
 * NotificationPreference for that event (email/slack toggles, targets).
 * Otherwise falls back to legacy behavior: email all operators with notifyEmail=true,
 * Slack all operators with notifySlack=true.
 */
export async function notifyOperators(
  mailer: Mailer,
  getActiveOperators: () => Promise<OperatorRecord[]>,
  opts: NotifyOperatorsOpts,
): Promise<string[]>;
export async function notifyOperators(
  mailer: Mailer,
  getActiveOperators: () => Promise<OperatorRecord[]>,
  opts: NotifyOperatorsOpts & { returnResult: true },
): Promise<NotifyOperatorsResult>;
export async function notifyOperators(
  mailer: Mailer,
  getActiveOperators: () => Promise<OperatorRecord[]>,
  opts: NotifyOperatorsOpts & { returnResult?: boolean },
): Promise<string[] | NotifyOperatorsResult> {
  const operators = await getActiveOperators();

  // Try event-driven dispatch
  if (opts.event && opts.getPreference) {
    const pref = await opts.getPreference(opts.event);
    if (pref && pref.isActive) {
      return dispatchWithPreference(mailer, operators, opts, pref);
    }
    // No preference found or inactive — fall through to legacy behavior
  }

  return legacyDispatch(mailer, operators, opts);
}

/** Legacy dispatch: email/Slack all operators based on per-operator toggles. */
async function legacyDispatch(
  mailer: Mailer,
  operators: OperatorRecord[],
  opts: NotifyOperatorsOpts,
): Promise<string[] | NotifyOperatorsResult> {
  let recipients: OperatorRecord[];

  if (opts.operatorId) {
    const assigned = operators.find(o => o.id === opts.operatorId && (o.notifyEmail || o.notifySlack));
    recipients = assigned ? [assigned] : operators.filter(o => o.notifyEmail || o.notifySlack);
  } else {
    recipients = operators.filter(o => o.notifyEmail || o.notifySlack);
  }

  if (recipients.length === 0) {
    logger.warn('No operators to notify — either none are active or none have notifications enabled');
    return opts.returnResult ? { emailRecipients: [], slackMessages: [] } : [];
  }

  const emailRecipients: string[] = [];
  const slackMessages: Array<SlackMessageResult & { operatorId?: string }> = [];

  for (const op of recipients) {
    if (op.notifyEmail) {
      try {
        await mailer.send({ to: op.email, subject: opts.subject, body: opts.body });
        emailRecipients.push(op.email);
        logger.info({ to: op.email, subject: opts.subject }, 'Operator email notification sent');
      } catch (err) {
        logger.error({ err, to: op.email }, 'Failed to send operator email notification');
      }
    }

    // Slack notification — fire in parallel, never block overall delivery
    if (op.notifySlack && opts.slack?.isConnected()) {
      const slackText = `*${opts.subject}*\n${opts.body}`;
      const blocks = opts.slackBlocks;
      try {
        if (op.slackUserId) {
          if (opts.slack.sendDMWithTs) {
            const result = await opts.slack.sendDMWithTs(op.slackUserId, slackText, blocks);
            slackMessages.push({ ...result, operatorId: op.id });
          } else {
            await opts.slack.sendDM(op.slackUserId, slackText, blocks);
          }
          logger.info({ slackUserId: op.slackUserId }, 'Operator Slack DM sent');
        } else if (opts.defaultSlackChannelId) {
          if (opts.slack.sendMessageWithTs) {
            const result = await opts.slack.sendMessageWithTs(opts.defaultSlackChannelId, slackText, blocks);
            slackMessages.push({ ...result, operatorId: op.id });
          } else {
            await opts.slack.sendMessage(opts.defaultSlackChannelId, slackText, blocks);
          }
          logger.info({ channelId: opts.defaultSlackChannelId }, 'Operator Slack channel notification sent');
        } else {
          logger.warn({ operatorId: op.id }, 'Operator has notifySlack=true but no slackUserId and no default channel');
        }
      } catch (err) {
        logger.warn({ err, operatorId: op.id }, 'Failed to send Slack notification (non-blocking)');
      }
    }
  }

  if (opts.returnResult) {
    return { emailRecipients, slackMessages };
  }
  return emailRecipients;
}

/** Event-driven dispatch: use preference to control which channels and targets. */
async function dispatchWithPreference(
  mailer: Mailer,
  operators: OperatorRecord[],
  opts: NotifyOperatorsOpts,
  pref: NotificationPreference,
): Promise<string[] | NotifyOperatorsResult> {
  const emailRecipients: string[] = [];
  const slackMessages: Array<SlackMessageResult & { operatorId?: string }> = [];
  const slackText = `*${opts.subject}*\n${opts.body}`;
  const blocks = opts.slackBlocks;

  // Email dispatch
  if (pref.emailEnabled) {
    const emailTarget = pref.emailTarget ?? 'all_operators';
    const targets = resolveEmailRecipients(operators, emailTarget, opts.operatorId);

    for (const email of targets) {
      try {
        await mailer.send({ to: email, subject: opts.subject, body: opts.body });
        emailRecipients.push(email);
        logger.info({ to: email, event: opts.event }, 'Event-driven email notification sent');
      } catch (err) {
        logger.error({ err, to: email, event: opts.event }, 'Failed to send event-driven email notification');
      }
    }
  }

  // Slack dispatch
  if (pref.slackEnabled && opts.slack?.isConnected()) {
    // null slackTarget means "Default Channel" in the UI — route to defaultSlackChannelId when
    // available, and only fall back to 'all_operators' if no default channel is configured.
    const slackTarget = pref.slackTarget ?? (opts.defaultSlackChannelId ? opts.defaultSlackChannelId : 'all_operators');

    try {
      if (slackTarget === 'assigned_operator') {
        // Respect notifySlack opt-out: assigned operator must have both a slackUserId and notifySlack=true
        const assigned = opts.operatorId
          ? operators.find(o => o.id === opts.operatorId && o.notifySlack && o.slackUserId)
          : null;
        if (assigned?.slackUserId) {
          if (opts.slack.sendDMWithTs) {
            const result = await opts.slack.sendDMWithTs(assigned.slackUserId, slackText, blocks);
            slackMessages.push({ ...result, operatorId: assigned.id });
          } else {
            await opts.slack.sendDM(assigned.slackUserId, slackText, blocks);
          }
          logger.info({ slackUserId: assigned.slackUserId, event: opts.event }, 'Event-driven Slack DM sent to assigned operator');
        } else if (opts.defaultSlackChannelId) {
          if (opts.slack.sendMessageWithTs) {
            const result = await opts.slack.sendMessageWithTs(opts.defaultSlackChannelId, slackText, blocks);
            slackMessages.push({ ...result });
          } else {
            await opts.slack.sendMessage(opts.defaultSlackChannelId, slackText, blocks);
          }
          logger.info({ event: opts.event }, 'Assigned operator not eligible for Slack — sent to default channel');
        }
      } else if (slackTarget === 'all_operators') {
        for (const op of operators.filter(o => o.notifySlack)) {
          if (op.slackUserId) {
            if (opts.slack.sendDMWithTs) {
              const result = await opts.slack.sendDMWithTs(op.slackUserId, slackText, blocks);
              slackMessages.push({ ...result, operatorId: op.id });
            } else {
              await opts.slack.sendDM(op.slackUserId, slackText, blocks);
            }
            logger.info({ slackUserId: op.slackUserId, event: opts.event }, 'Event-driven Slack DM sent');
          } else if (opts.defaultSlackChannelId) {
            if (opts.slack.sendMessageWithTs) {
              const result = await opts.slack.sendMessageWithTs(opts.defaultSlackChannelId, slackText, blocks);
              slackMessages.push({ ...result });
            } else {
              await opts.slack.sendMessage(opts.defaultSlackChannelId, slackText, blocks);
            }
          }
        }
      } else if (slackTarget.startsWith('operator:')) {
        const id = slackTarget.slice('operator:'.length);
        const op = operators.find(o => o.id === id);
        if (op?.slackUserId && op.notifySlack) {
          if (opts.slack.sendDMWithTs) {
            const result = await opts.slack.sendDMWithTs(op.slackUserId, slackText, blocks);
            slackMessages.push({ ...result, operatorId: op.id });
          } else {
            await opts.slack.sendDM(op.slackUserId, slackText, blocks);
          }
          logger.info({ slackUserId: op.slackUserId, event: opts.event }, 'Event-driven Slack DM sent to specific operator');
        } else if (opts.defaultSlackChannelId) {
          if (opts.slack.sendMessageWithTs) {
            const result = await opts.slack.sendMessageWithTs(opts.defaultSlackChannelId, slackText, blocks);
            slackMessages.push({ ...result });
          } else {
            await opts.slack.sendMessage(opts.defaultSlackChannelId, slackText, blocks);
          }
          logger.info({ event: opts.event }, 'Specific operator not eligible for Slack DM — sent to default channel');
        }
      } else {
        // Treat as a channel ID
        if (opts.slack.sendMessageWithTs) {
          const result = await opts.slack.sendMessageWithTs(slackTarget, slackText, blocks);
          slackMessages.push({ ...result });
        } else {
          await opts.slack.sendMessage(slackTarget, slackText, blocks);
        }
        logger.info({ channelId: slackTarget, event: opts.event }, 'Event-driven Slack channel message sent');
      }
    } catch (err) {
      logger.warn({ err, event: opts.event }, 'Failed to send event-driven Slack notification (non-blocking)');
    }
  }

  if (opts.returnResult) {
    return { emailRecipients, slackMessages };
  }
  return emailRecipients;
}

/**
 * A client-side person who can receive notifications routed to a client (used
 * when `client.notificationMode === 'operator'`). These are people on the
 * client team with `userType` of OPERATOR or ADMIN.
 */
export interface ClientOperatorRecord {
  id: string;
  email: string;
  name: string;
  userType: string;
  slackUserId: string | null;
}

export interface NotifyClientOperatorsOpts {
  subject: string;
  body: string;
  clientId: string;
  slack?: SlackSender;
  /** Optional Slack channel for the client (sends a channel message in addition to DMs). */
  slackChannelId?: string;
}

/**
 * Notify client operators (people on the client team with userType ADMIN/OPERATOR
 * and hasOpsAccess). Used by the NOTIFY_OPERATOR step when a client has
 * `notificationMode === 'operator'` and wants resolution notifications routed to
 * its own ops team instead of (or in addition to) the platform operators.
 *
 * Returns the list of email addresses that received the notification.
 */
export async function notifyClientOperators(
  mailer: Mailer,
  getClientOperators: (clientId: string) => Promise<ClientOperatorRecord[]>,
  opts: NotifyClientOperatorsOpts,
): Promise<string[]> {
  const operators = await getClientOperators(opts.clientId);
  const recipients: string[] = [];

  if (operators.length === 0) {
    logger.warn({ clientId: opts.clientId }, 'No client operators to notify');
  }

  for (const op of operators) {
    try {
      await mailer.send({ to: op.email, subject: opts.subject, body: opts.body });
      recipients.push(op.email);
      logger.info({ to: op.email, clientId: opts.clientId }, 'Client operator notification sent');
    } catch (err) {
      logger.error({ err, to: op.email }, 'Failed to send client operator notification');
    }

    if (op.slackUserId && opts.slack?.isConnected()) {
      try {
        await opts.slack.sendDM(op.slackUserId, `*${opts.subject}*\n${opts.body}`);
      } catch (err) {
        logger.warn({ err, slackUserId: op.slackUserId }, 'Failed to send client operator Slack DM');
      }
    }
  }

  if (opts.slackChannelId && opts.slack?.isConnected()) {
    try {
      await opts.slack.sendMessage(opts.slackChannelId, `*${opts.subject}*\n${opts.body}`);
    } catch (err) {
      logger.warn({ err, channelId: opts.slackChannelId }, 'Failed to send client Slack channel notification');
    }
  }

  return recipients;
}

function resolveEmailRecipients(
  operators: OperatorRecord[],
  emailTarget: string,
  operatorId?: string,
): string[] {
  if (emailTarget === 'assigned_operator') {
    if (operatorId) {
      const assigned = operators.find(o => o.id === operatorId && o.notifyEmail);
      return assigned ? [assigned.email] : operators.filter(o => o.notifyEmail).map(o => o.email);
    }
    return operators.filter(o => o.notifyEmail).map(o => o.email);
  }

  if (emailTarget === 'all_operators') {
    return operators.filter(o => o.notifyEmail).map(o => o.email);
  }

  if (emailTarget.startsWith('operator:')) {
    const id = emailTarget.slice('operator:'.length);
    const op = operators.find(o => o.id === id && o.notifyEmail);
    return op ? [op.email] : [];
  }

  // Specific email address
  if (emailTarget.includes('@')) {
    return [emailTarget];
  }

  // Fallback
  return operators.filter(o => o.notifyEmail).map(o => o.email);
}
