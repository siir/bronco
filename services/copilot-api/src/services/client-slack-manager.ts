import type { PrismaClient } from '@bronco/db';
import type { Queue } from 'bullmq';
import { SlackClient, createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';
import { IntegrationType, TicketSource } from '@bronco/shared-types';
import type { IngestionJob, SlackIngestionPayload } from '@bronco/shared-types';

const logger = createLogger('client-slack-manager');

interface ClientSlackEntry {
  integrationId: string;
  clientId: string;
  client: SlackClient;
  defaultChannelId: string;
  /** Serialized snapshot of the config at connection time, used to detect changes. */
  configSnapshot: string;
}

/**
 * Manages multiple Slack Socket Mode connections — one per active client Slack integration.
 * Each client workspace has its own bot/app tokens and operates independently.
 */
export class ClientSlackManager {
  private connections = new Map<string, ClientSlackEntry>();
  private db: PrismaClient;
  private encryptionKey: string;
  private ingestQueue: Queue<IngestionJob>;

  constructor(db: PrismaClient, encryptionKey: string, ingestQueue: Queue<IngestionJob>) {
    this.db = db;
    this.encryptionKey = encryptionKey;
    this.ingestQueue = ingestQueue;
  }

  /** Get the SlackClient for a specific client (by clientId). */
  getClientSlack(clientId: string): SlackClient | null {
    const entry = this.getClientEntry(clientId);
    return entry?.client ?? null;
  }

  /** Get the connection entry for a client (includes channel info). */
  getClientEntry(clientId: string): ClientSlackEntry | null {
    const matches: ClientSlackEntry[] = [];
    for (const entry of this.connections.values()) {
      if (entry.clientId === clientId) matches.push(entry);
    }
    if (matches.length > 1) {
      logger.error({ clientId, count: matches.length }, 'Multiple active Slack integrations found for client — expected at most one');
      throw new Error(`Multiple active Slack integrations found for client ${clientId}`);
    }
    return matches[0] ?? null;
  }

  /**
   * Load all active SLACK integrations from DB and establish Socket Mode connections.
   * Safe to call multiple times — disconnects stale connections and reconnects changed ones.
   */
  async refreshConnections(): Promise<void> {
    // SLACK integrations are always client-scoped (platform scope only exists
    // for GITHUB today). Filter clientId not-null defensively.
    const integrations = await this.db.clientIntegration.findMany({
      where: { type: IntegrationType.SLACK, isActive: true, clientId: { not: null } },
      select: { id: true, clientId: true, config: true },
    });

    const activeIds = new Set(integrations.map((i) => i.id));

    // Disconnect integrations that are no longer active
    for (const [id, entry] of this.connections) {
      if (!activeIds.has(id)) {
        logger.info({ integrationId: id, clientId: entry.clientId }, 'Disconnecting removed/inactive client Slack');
        await this.safeDisconnect(entry.client, id);
        this.connections.delete(id);
      }
    }

    // Connect new integrations; reconnect if config has changed; disconnect if disabled
    for (const integ of integrations) {
      if (!integ.clientId) continue; // defensive — clientId: not null filter should guarantee this
      const cfg = integ.config as Record<string, unknown>;
      const enabled = cfg['enabled'] !== false;
      const currentSnapshot = JSON.stringify(cfg);

      const existing = this.connections.get(integ.id);

      if (existing) {
        // Already connected — check if config has changed or integration was disabled
        if (!enabled) {
          logger.info({ integrationId: integ.id, clientId: integ.clientId }, 'Client Slack integration disabled — disconnecting');
          await this.safeDisconnect(existing.client, integ.id);
          this.connections.delete(integ.id);
          continue;
        }
        if (existing.configSnapshot === currentSnapshot) continue; // no change
        // Config changed — tear down and reconnect below
        logger.info({ integrationId: integ.id, clientId: integ.clientId }, 'Client Slack config changed — reconnecting');
        await this.safeDisconnect(existing.client, integ.id);
        this.connections.delete(integ.id);
      }

      if (!enabled) continue;

      const botToken = this.decryptToken(cfg['encryptedBotToken']);
      const appToken = this.decryptToken(cfg['encryptedAppToken']);
      const defaultChannelId = typeof cfg['defaultChannelId'] === 'string' ? cfg['defaultChannelId'] : '';

      if (!botToken || !appToken || !defaultChannelId) {
        logger.warn({ integrationId: integ.id, clientId: integ.clientId }, 'Client Slack integration missing tokens or channel — skipping');
        continue;
      }

      try {
        const client = new SlackClient({ botToken, appToken });
        await client.connect();

        const entry: ClientSlackEntry = {
          integrationId: integ.id,
          clientId: integ.clientId,
          client,
          defaultChannelId,
          configSnapshot: currentSnapshot,
        };
        this.connections.set(integ.id, entry);

        // Register message handler for inbound ticket submission
        this.registerMessageHandler(entry);

        logger.info({ integrationId: integ.id, clientId: integ.clientId }, 'Client Slack connection established');
      } catch (err) {
        logger.error({ err, integrationId: integ.id, clientId: integ.clientId }, 'Failed to connect client Slack — skipping (other clients unaffected)');
      }
    }

    logger.info({ activeConnections: this.connections.size }, 'Client Slack connections refreshed');
  }

  /** Gracefully disconnect all client Slack connections. */
  async disconnectAll(): Promise<void> {
    for (const [id, entry] of this.connections) {
      await this.safeDisconnect(entry.client, id);
    }
    this.connections.clear();
    logger.info('All client Slack connections disconnected');
  }

  /**
   * Register a Socket Mode message handler on a client's Slack connection.
   * When a message arrives, resolve the sender to a Person and enqueue for ingestion.
   */
  private registerMessageHandler(entry: ClientSlackEntry): void {
    // SocketModeClient emits envelopes: { envelope_id, payload, ack, body, ... }
    // The `payload` field contains the actual event data; ack must be called to acknowledge.
    entry.client.socket.on('message', async (args: { payload?: Record<string, unknown>; envelope_id?: string; ack?: () => Promise<void> }) => {
      try {
        if (typeof args.ack === 'function') await args.ack();
        const event = args.payload;
        if (event) {
          await this.handleInboundMessage(entry, event);
        }
      } catch (err) {
        logger.error({ err, integrationId: entry.integrationId }, 'Error handling inbound Slack message');
      }
    });
  }

  /**
   * Handle an inbound Slack message from a client workspace.
   * Resolves the sender to a Person and enqueues an ingestion job.
   */
  private async handleInboundMessage(entry: ClientSlackEntry, event: Record<string, unknown>): Promise<void> {
    // Extract message fields from the Slack event
    const text = typeof event['text'] === 'string' ? event['text'] : '';
    const slackUserId = typeof event['user'] === 'string' ? event['user'] : '';
    const channelId = typeof event['channel'] === 'string' ? event['channel'] : '';
    const threadTs = typeof event['thread_ts'] === 'string' ? event['thread_ts'] : undefined;
    const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : '';

    // Skip bot messages, message_changed, etc.
    if (subtype || !slackUserId || !text) return;

    // Check if this is a reply to an existing ticket thread
    if (threadTs) {
      await this.handleThreadReply(entry, slackUserId, channelId, threadTs, text);
      return;
    }

    // Resolve Slack user to a Person
    const person = await this.resolvePerson(entry.clientId, slackUserId);

    if (!person) {
      // Check if client allows self-registration
      const client = await this.db.client.findUnique({
        where: { id: entry.clientId },
        select: { allowSelfRegistration: true },
      });

      if (client?.allowSelfRegistration) {
        // Auto-create person with Slack user info (with a ClientUser row so
        // future lookups scope to this client). Person no longer carries a
        // slackUserId column in the unified model.
        const userInfo = await this.fetchSlackUserInfo(entry.client, slackUserId);
        if (userInfo) {
          const email = userInfo.email || `${slackUserId}@slack.local`;
          const emailLower = email.toLowerCase();
          const newPerson = await this.db.$transaction(async (tx) => {
            const person = await tx.person.upsert({
              where: { emailLower },
              update: { name: userInfo.name },
              create: { name: userInfo.name, email, emailLower },
            });
            await tx.clientUser.upsert({
              where: { personId_clientId: { personId: person.id, clientId: entry.clientId } },
              update: {},
              create: { personId: person.id, clientId: entry.clientId, userType: 'USER' },
            });
            return person;
          });
          await this.enqueueSlackIngestion(entry, slackUserId, userInfo.name, channelId, text, newPerson.id);
          return;
        }
      }

      // No person match and no self-registration — reply with guidance
      try {
        await entry.client.sendMessage(
          channelId,
          "I don't recognize you — please ask your admin to add your Slack ID to your contact record.",
        );
      } catch (err) {
        logger.warn({ err, channelId }, 'Failed to send unrecognized user reply');
      }
      return;
    }

    await this.enqueueSlackIngestion(entry, slackUserId, person.name, channelId, text, person.id);
  }

  /**
   * Handle a reply in a Slack thread that may be tied to an existing ticket.
   */
  private async handleThreadReply(
    entry: ClientSlackEntry,
    slackUserId: string,
    channelId: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    // Look up ticket by thread metadata, scoped to this client to prevent cross-workspace collisions
    const ticketEvent = await this.db.ticketEvent.findFirst({
      where: {
        eventType: 'SLACK_OUTBOUND',
        metadata: { path: ['slackThreadTs'], equals: threadTs },
        ticket: { clientId: entry.clientId },
      },
      select: { ticketId: true },
    });

    if (!ticketEvent) {
      // Thread not associated with a ticket — treat as a new message
      const person = await this.resolvePerson(entry.clientId, slackUserId);
      if (person) {
        await this.enqueueSlackIngestion(entry, slackUserId, person.name, channelId, text, person.id);
      }
      return;
    }

    // Resolve person
    const person = await this.resolvePerson(entry.clientId, slackUserId);
    const personName = person?.name ?? slackUserId;

    // Append as SLACK_INBOUND event on the existing ticket
    await this.db.ticketEvent.create({
      data: {
        ticketId: ticketEvent.ticketId,
        eventType: 'SLACK_INBOUND',
        content: text,
        actor: personName,
        metadata: { slackUserId, slackChannelId: channelId, slackThreadTs: threadTs },
      },
    });

    logger.info({ ticketId: ticketEvent.ticketId, slackUserId }, 'Slack thread reply appended to ticket');
  }

  /**
   * Enqueue a Slack message as an ingestion job.
   */
  private async enqueueSlackIngestion(
    entry: ClientSlackEntry,
    slackUserId: string,
    slackUsername: string,
    channelId: string,
    text: string,
    personId: string,
  ): Promise<void> {
    const payload: SlackIngestionPayload = {
      slackUserId,
      slackUsername,
      slackChannelId: channelId,
      text,
      personId,
      integrationId: entry.integrationId,
    };

    await this.ingestQueue.add('ingest', {
      source: TicketSource.SLACK,
      clientId: entry.clientId,
      payload: payload as unknown as Record<string, unknown>,
    }, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 30_000 },
    });

    // Reply in channel confirming ticket creation
    try {
      await entry.client.sendMessage(channelId, "Got it — we'll create a ticket and follow up here.");
    } catch (err) {
      logger.warn({ err, channelId }, 'Failed to send Slack acknowledgement');
    }

    logger.info({ clientId: entry.clientId, slackUserId, channelId }, 'Slack message enqueued for ingestion');
  }

  /** Resolve a Slack user ID to a Person record. */
  private async resolvePerson(clientId: string, slackUserId: string): Promise<{ id: string; name: string; email: string } | null> {
    // Person no longer stores slackUserId directly — resolve via Operator.
    const op = await this.db.operator.findFirst({
      where: { slackUserId, clientId },
      select: {
        person: { select: { id: true, name: true, email: true } },
      },
    });
    return op?.person ?? null;
  }

  /** Fetch Slack user info (name, email) from the workspace API. */
  private async fetchSlackUserInfo(client: SlackClient, slackUserId: string): Promise<{ name: string; email: string } | null> {
    try {
      const result = await client.web.users.info({ user: slackUserId });
      return {
        name: result.user?.real_name ?? slackUserId,
        email: result.user?.profile?.email ?? '',
      };
    } catch (err) {
      logger.warn({ err, slackUserId }, 'Failed to fetch Slack user info');
      return null;
    }
  }

  private decryptToken(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    if (!looksEncrypted(value)) return value;
    try {
      return decrypt(value, this.encryptionKey);
    } catch (err) {
      logger.warn({ err }, 'Failed to decrypt client Slack token');
      return null;
    }
  }

  private async safeDisconnect(client: SlackClient, integrationId: string): Promise<void> {
    try {
      await client.disconnect();
    } catch (err) {
      logger.warn({ err, integrationId }, 'Error disconnecting client Slack');
    }
  }
}
