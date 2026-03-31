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

export interface SlackSender {
  sendDM(slackUserId: string, text: string, blocks?: unknown[]): Promise<void>;
  sendDMWithTs?(slackUserId: string, text: string, blocks?: unknown[]): Promise<SlackMessageResult>;
  sendMessage(channelId: string, text: string, blocks?: unknown[]): Promise<void>;
  sendMessageWithTs?(channelId: string, text: string, blocks?: unknown[]): Promise<SlackMessageResult>;
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
  /** Optional Block Kit blocks for rich Slack messages. */
  slackBlocks?: unknown[];
}

/** Result of a notification run, including Slack message metadata for thread tracking. */
export interface NotifyOperatorsResult {
  /** Email addresses that received notifications. */
  emailRecipients: string[];
  /** Slack message metadata for each successfully sent Slack message. */
  slackMessages: Array<SlackMessageResult & { operatorId?: string }>;
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
    return opts.returnResult ? { emailRecipients: [], slackMessages: [] } : [];
  }

  const emailRecipients: string[] = [];
  const slackMessages: Array<SlackMessageResult & { operatorId?: string }> = [];

  for (const op of recipients) {
    // Email notification
    if (op.notifyEmail) {
      try {
        await mailer.send({ to: op.email, subject: opts.subject, body: opts.body });
        emailRecipients.push(op.email);
        logger.info({ to: op.email, subject: opts.subject }, 'Operator email notification sent');
      } catch (err) {
        logger.error({ err, to: op.email }, 'Failed to send operator email notification');
      }
    }

    // Slack notification (non-blocking — never fail the overall notification)
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
