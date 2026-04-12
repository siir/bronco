import type { PrismaClient } from '@bronco/db';
import { createLogger } from '@bronco/shared-utils';
import type { ClientSlackManager } from './client-slack-manager.js';

const logger = createLogger('client-notifications');

export interface ClientNotificationOpts {
  db: PrismaClient;
  clientSlackManager: ClientSlackManager;
}

/**
 * Send sanitized ticket notifications to a client's Slack workspace.
 * Only client-facing content is included — no internal operator notes, plans, or system data.
 */
export async function notifyClientSlack(
  opts: ClientNotificationOpts,
  clientId: string,
  ticketId: string,
  event: 'acknowledged' | 'findings_ready' | 'status_change' | 'resolution_complete',
  details: { summary?: string; newStatus?: string; branch?: string },
): Promise<void> {
  const entry = opts.clientSlackManager.getClientEntry(clientId);
  if (!entry) return; // No Slack integration for this client

  const ticket = await opts.db.ticket.findUnique({
    where: { id: ticketId },
    select: { subject: true, ticketNumber: true },
  });
  if (!ticket) return;

  const ticketLabel = `#${ticket.ticketNumber ?? '?'} — ${ticket.subject}`;

  let message: string;
  switch (event) {
    case 'acknowledged':
      message = `We received your request and are looking into it.\n*${ticketLabel}*`;
      break;
    case 'findings_ready':
      message = `Analysis findings are ready for your ticket.\n*${ticketLabel}*${details.summary ? `\n\n${details.summary}` : ''}`;
      break;
    case 'status_change':
      message = `Your ticket status changed to *${details.newStatus ?? 'updated'}*.\n*${ticketLabel}*`;
      break;
    case 'resolution_complete':
      message = `Changes have been pushed to branch \`${details.branch ?? 'unknown'}\`.\n*${ticketLabel}*`;
      break;
    default:
      return;
  }

  try {
    const result = await entry.client.sendMessageWithTs(entry.defaultChannelId, message);
    // Store thread TS in ticket event metadata for future thread replies
    await opts.db.ticketEvent.create({
      data: {
        ticketId,
        eventType: 'SLACK_OUTBOUND',
        content: message,
        actor: 'system',
        metadata: {
          slackChannelId: result.channelId,
          slackThreadTs: result.ts,
          clientNotification: true,
        },
      },
    });
    logger.info({ ticketId, event, clientId }, 'Client Slack notification sent');
  } catch (err) {
    logger.warn({ err, ticketId, event, clientId }, 'Failed to send client Slack notification');
  }
}

/**
 * Send a direct message to a specific contact in the client's Slack workspace.
 */
export async function notifyClientContactDM(
  opts: ClientNotificationOpts,
  clientId: string,
  contactId: string,
  message: string,
): Promise<void> {
  const entry = opts.clientSlackManager.getClientEntry(clientId);
  if (!entry) return;

  const person = await opts.db.person.findUnique({
    where: { id: contactId },
    select: { slackUserId: true },
  });
  if (!person?.slackUserId) return;

  try {
    await entry.client.sendDM(person.slackUserId, message);
    logger.info({ clientId, contactId }, 'Client contact DM sent');
  } catch (err) {
    logger.warn({ err, clientId, contactId }, 'Failed to send client contact DM');
  }
}
