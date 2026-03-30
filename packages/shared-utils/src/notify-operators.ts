import { createLogger } from './logger.js';
import type { Mailer } from './mailer.js';

const logger = createLogger('notify-operators');

export interface OperatorRecord {
  id: string;
  email: string;
  name: string;
  notifyEmail: boolean;
}

export interface NotifyOperatorsOpts {
  /** Subject line for the notification email. */
  subject: string;
  /** Plain-text body. */
  body: string;
  /** If provided, only notify this specific operator (e.g. the assigned operator). */
  operatorId?: string;
}

/**
 * Send a notification email to all active operators with notifyEmail=true.
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
    const assigned = operators.find(o => o.id === opts.operatorId && o.notifyEmail);
    // Fall back to all operators if the assigned one has notifications disabled or doesn't exist
    recipients = assigned ? [assigned] : operators.filter(o => o.notifyEmail);
  } else {
    recipients = operators.filter(o => o.notifyEmail);
  }

  if (recipients.length === 0) {
    logger.warn('No operators to notify — either none are active or none have notifyEmail enabled');
    return [];
  }

  const notified: string[] = [];
  for (const op of recipients) {
    try {
      await mailer.send({ to: op.email, subject: opts.subject, body: opts.body });
      notified.push(op.email);
      logger.info({ to: op.email, subject: opts.subject }, 'Operator notification sent');
    } catch (err) {
      logger.error({ err, to: op.email }, 'Failed to send operator notification');
    }
  }

  return notified;
}
