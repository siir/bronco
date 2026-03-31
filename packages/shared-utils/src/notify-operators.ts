import { createLogger } from './logger.js';
import type { Mailer } from './mailer.js';

const logger = createLogger('notify-operators');

export interface OperatorRecord {
  id: string;
  email: string;
  name: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackUserId: string | null;
}

export interface SlackSender {
  sendDM(slackUserId: string, text: string): Promise<void>;
  sendMessage(channelId: string, text: string): Promise<void>;
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
  /** Notification event type — when provided, looks up preferences to control dispatch. */
  event?: string;
  /** Function to load the notification preference for the given event. */
  getPreference?: (event: string) => Promise<NotificationPreference | null>;
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
): Promise<string[]> {
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
): Promise<string[]> {
  let recipients: OperatorRecord[];

  if (opts.operatorId) {
    const assigned = operators.find(o => o.id === opts.operatorId && (o.notifyEmail || o.notifySlack));
    recipients = assigned ? [assigned] : operators.filter(o => o.notifyEmail || o.notifySlack);
  } else {
    recipients = operators.filter(o => o.notifyEmail || o.notifySlack);
  }

  if (recipients.length === 0) {
    logger.warn('No operators to notify — either none are active or none have notifications enabled');
    return [];
  }

  const notified: string[] = [];
  for (const op of recipients) {
    if (op.notifyEmail) {
      try {
        await mailer.send({ to: op.email, subject: opts.subject, body: opts.body });
        notified.push(op.email);
        logger.info({ to: op.email, subject: opts.subject }, 'Operator email notification sent');
      } catch (err) {
        logger.error({ err, to: op.email }, 'Failed to send operator email notification');
      }
    }

    if (op.notifySlack && opts.slack?.isConnected()) {
      const slackText = `*${opts.subject}*\n${opts.body}`;
      try {
        if (op.slackUserId) {
          await opts.slack.sendDM(op.slackUserId, slackText);
          logger.info({ slackUserId: op.slackUserId }, 'Operator Slack DM sent');
        } else if (opts.defaultSlackChannelId) {
          await opts.slack.sendMessage(opts.defaultSlackChannelId, slackText);
          logger.info({ channelId: opts.defaultSlackChannelId }, 'Operator Slack channel notification sent');
        } else {
          logger.warn({ operatorId: op.id }, 'Operator has notifySlack=true but no slackUserId and no default channel');
        }
      } catch (err) {
        logger.warn({ err, operatorId: op.id }, 'Failed to send Slack notification (non-blocking)');
      }
    }
  }

  return notified;
}

/** Event-driven dispatch: use preference to control which channels and targets. */
async function dispatchWithPreference(
  mailer: Mailer,
  operators: OperatorRecord[],
  opts: NotifyOperatorsOpts,
  pref: NotificationPreference,
): Promise<string[]> {
  const notified: string[] = [];
  const slackText = `*${opts.subject}*\n${opts.body}`;

  // Email dispatch
  if (pref.emailEnabled) {
    const emailTarget = pref.emailTarget ?? 'all_operators';
    const emailRecipients = resolveEmailRecipients(operators, emailTarget, opts.operatorId);

    for (const email of emailRecipients) {
      try {
        await mailer.send({ to: email, subject: opts.subject, body: opts.body });
        notified.push(email);
        logger.info({ to: email, event: opts.event }, 'Event-driven email notification sent');
      } catch (err) {
        logger.error({ err, to: email, event: opts.event }, 'Failed to send event-driven email notification');
      }
    }
  }

  // Slack dispatch
  if (pref.slackEnabled && opts.slack?.isConnected()) {
    const slackTarget = pref.slackTarget ?? 'all_operators';

    try {
      if (slackTarget === 'assigned_operator') {
        const assigned = opts.operatorId
          ? operators.find(o => o.id === opts.operatorId && o.slackUserId)
          : null;
        if (assigned?.slackUserId) {
          await opts.slack.sendDM(assigned.slackUserId, slackText);
          logger.info({ slackUserId: assigned.slackUserId, event: opts.event }, 'Event-driven Slack DM sent to assigned operator');
        } else if (opts.defaultSlackChannelId) {
          await opts.slack.sendMessage(opts.defaultSlackChannelId, slackText);
          logger.info({ event: opts.event }, 'Assigned operator has no Slack ID — sent to default channel');
        }
      } else if (slackTarget === 'all_operators') {
        for (const op of operators.filter(o => o.notifySlack)) {
          if (op.slackUserId) {
            await opts.slack.sendDM(op.slackUserId, slackText);
            logger.info({ slackUserId: op.slackUserId, event: opts.event }, 'Event-driven Slack DM sent');
          } else if (opts.defaultSlackChannelId) {
            await opts.slack.sendMessage(opts.defaultSlackChannelId, slackText);
          }
        }
      } else {
        // Treat as a channel ID
        await opts.slack.sendMessage(slackTarget, slackText);
        logger.info({ channelId: slackTarget, event: opts.event }, 'Event-driven Slack channel message sent');
      }
    } catch (err) {
      logger.warn({ err, event: opts.event }, 'Failed to send event-driven Slack notification (non-blocking)');
    }
  }

  return notified;
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

  // Specific email address
  if (emailTarget.includes('@')) {
    return [emailTarget];
  }

  // Fallback
  return operators.filter(o => o.notifyEmail).map(o => o.email);
}
