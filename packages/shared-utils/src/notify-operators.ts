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
}

/**
 * Send a notification email to all active operators with notifyEmail=true.
 * Optionally send Slack DMs/channel messages for operators with notifySlack=true.
 *
 * If `operatorId` is provided, only that operator is notified (useful when a
 * ticket is assigned). Falls back to all active operators when `operatorId` is
 * absent or the specified operator is not found / has notifications disabled.
 *
 * Requires a function that returns active operators — this avoids a direct
 * dependency on PrismaClient so the helper stays in shared-utils.
 */
export async function notifyOperators(
  mailer: Mailer,
  getActiveOperators: () => Promise<OperatorRecord[]>,
  opts: NotifyOperatorsOpts,
): Promise<string[]> {
  const operators = await getActiveOperators();

  let recipients: OperatorRecord[];

  if (opts.operatorId) {
    const assigned = operators.find(o => o.id === opts.operatorId && (o.notifyEmail || o.notifySlack));
    // Fall back to all operators if the assigned one has notifications disabled or doesn't exist
    recipients = assigned ? [assigned] : operators.filter(o => o.notifyEmail || o.notifySlack);
  } else {
    recipients = operators.filter(o => o.notifyEmail || o.notifySlack);
  }

  if (recipients.length === 0) {
    logger.warn('No operators to notify — either none are active or none have notifications enabled');
    return [];
  }

  const notified: string[] = [];
  const slackPromises: Promise<void>[] = [];

  for (const op of recipients) {
    // Email notification
    if (op.notifyEmail) {
      try {
        await mailer.send({ to: op.email, subject: opts.subject, body: opts.body });
        notified.push(op.email);
        logger.info({ to: op.email, subject: opts.subject }, 'Operator email notification sent');
      } catch (err) {
        logger.error({ err, to: op.email }, 'Failed to send operator email notification');
      }
    }

    // Slack notification — fire in parallel, never block overall delivery
    if (op.notifySlack && opts.slack?.isConnected()) {
      const slackText = `*${opts.subject}*\n${opts.body}`;
      if (op.slackUserId) {
        slackPromises.push(
          opts.slack.sendDM(op.slackUserId, slackText).then(
            () => { logger.info({ slackUserId: op.slackUserId }, 'Operator Slack DM sent'); },
            (err) => { logger.warn({ err, operatorId: op.id }, 'Failed to send Slack DM (non-blocking)'); },
          ),
        );
      } else if (opts.defaultSlackChannelId) {
        slackPromises.push(
          opts.slack.sendMessage(opts.defaultSlackChannelId, slackText).then(
            () => { logger.info({ channelId: opts.defaultSlackChannelId }, 'Operator Slack channel notification sent'); },
            (err) => { logger.warn({ err, operatorId: op.id }, 'Failed to send Slack channel message (non-blocking)'); },
          ),
        );
      } else {
        logger.warn({ operatorId: op.id }, 'Operator has notifySlack=true but no slackUserId and no default channel');
      }
    }
  }

  // Wait for all Slack sends concurrently — allSettled ensures failures don't throw
  await Promise.allSettled(slackPromises);

  return notified;
}
