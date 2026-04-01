import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { createLogger } from './logger.js';

const logger = createLogger('slack-client');

export interface SlackClientOpts {
  botToken: string;
  appToken: string;
}

/** Metadata returned when a Slack message is sent successfully. */
export interface SlackMessageResult {
  channelId: string;
  ts: string;
}

/** Parsed block_actions payload from Slack Socket Mode. */
export interface SlackBlockAction {
  actionId: string;
  value: string;
  blockId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  triggerId: string;
}

/** Parsed message event payload from Slack Socket Mode. */
export interface SlackThreadMessage {
  userId: string;
  channelId: string;
  text: string;
  ts: string;
  threadTs: string;
}

/** Parsed @mention event payload from Slack Socket Mode. */
export interface SlackMentionEvent {
  userId: string;
  channelId: string;
  text: string;
  ts: string;
}

/** Parsed top-level DM event payload from Slack Socket Mode. */
export interface SlackDirectMessageEvent {
  userId: string;
  channelId: string;
  text: string;
  ts: string;
}

export type BlockActionHandler = (action: SlackBlockAction) => Promise<void>;
export type ThreadMessageHandler = (message: SlackThreadMessage) => Promise<void>;
export type MentionHandler = (event: SlackMentionEvent) => Promise<void>;
export type DirectMessageHandler = (event: SlackDirectMessageEvent) => Promise<void>;

export class SlackClient {
  readonly web: WebClient;
  readonly socket: SocketModeClient;
  private connected = false;
  private blockActionHandler: BlockActionHandler | null = null;
  private threadMessageHandler: ThreadMessageHandler | null = null;
  private mentionHandler: MentionHandler | null = null;
  private directMessageHandler: DirectMessageHandler | null = null;

  constructor(opts: SlackClientOpts) {
    this.web = new WebClient(opts.botToken);
    this.socket = new SocketModeClient({ appToken: opts.appToken });

    this.socket.on('connected', () => {
      this.connected = true;
      logger.info('Slack Socket Mode connected');
    });

    this.socket.on('disconnected', () => {
      this.connected = false;
      logger.warn('Slack Socket Mode disconnected');
    });

    // Handle interactive events (button clicks, modal submissions)
    this.socket.on('interactive', async ({ body, ack }) => {
      await ack();
      try {
        await this.handleInteractive(body);
      } catch (err) {
        logger.error({ err }, 'Error handling Slack interactive event');
      }
    });

    // Handle message events (threaded replies)
    this.socket.on('events_api', async ({ body, ack }) => {
      await ack();
      try {
        await this.handleEventsApi(body);
      } catch (err) {
        logger.error({ err }, 'Error handling Slack events_api event');
      }
    });
  }

  /** Register a handler for block_actions events (button clicks). */
  onBlockAction(handler: BlockActionHandler): void {
    this.blockActionHandler = handler;
  }

  /** Register a handler for threaded message events. */
  onThreadMessage(handler: ThreadMessageHandler): void {
    this.threadMessageHandler = handler;
  }

  /** Register a handler for @mention events in channels. */
  onMention(handler: MentionHandler): void {
    this.mentionHandler = handler;
  }

  /** Register a handler for top-level DM events (no thread). */
  onDirectMessage(handler: DirectMessageHandler): void {
    this.directMessageHandler = handler;
  }

  private async handleInteractive(body: Record<string, unknown>): Promise<void> {
    const type = body.type as string;

    if (type === 'block_actions' && this.blockActionHandler) {
      const actions = body.actions as Array<Record<string, unknown>> | undefined;
      const user = body.user as Record<string, unknown> | undefined;
      const channel = body.channel as Record<string, unknown> | undefined;
      const message = body.message as Record<string, unknown> | undefined;
      const triggerId = (body.trigger_id as string) ?? '';

      if (!actions?.length || !user?.id || !channel?.id) return;

      const messageTs = message?.ts as string | undefined;
      if (!messageTs) {
        logger.warn({ actionCount: actions.length, userId: user.id }, 'block_actions event missing message.ts — skipping handler');
        return;
      }

      for (const action of actions) {
        const blockAction: SlackBlockAction = {
          actionId: (action.action_id as string) ?? '',
          value: (action.value as string) ?? '',
          blockId: (action.block_id as string) ?? '',
          userId: user.id as string,
          channelId: channel.id as string,
          messageTs,
          triggerId,
        };
        await this.blockActionHandler(blockAction);
      }
    }

    if (type === 'view_submission') {
      // Modal submission for reject feedback
      const view = body.view as Record<string, unknown> | undefined;
      if (!view) return;

      const callbackId = view.callback_id as string;
      if (callbackId?.startsWith('plan_reject_modal_')) {
        const jobId = callbackId.replace('plan_reject_modal_', '');
        const stateValues = (view.state as Record<string, unknown>)?.values as Record<string, Record<string, Record<string, unknown>>> | undefined;
        const feedbackBlock = stateValues?.['reject_feedback_block']?.['reject_feedback_input'];
        const feedback = feedbackBlock?.value as string | undefined;
        const user = body.user as Record<string, unknown> | undefined;

        // Parse private_metadata to recover channelId/messageTs from the original action
        let channelId = '';
        let messageTs = '';
        const privateMetadata = view.private_metadata as string | undefined;
        if (privateMetadata) {
          try {
            const meta = JSON.parse(privateMetadata) as { channelId?: string; messageTs?: string };
            channelId = meta.channelId ?? '';
            messageTs = meta.messageTs ?? '';
          } catch {
            logger.warn({ privateMetadata }, 'Failed to parse view private_metadata');
          }
        }

        if (feedback && this.blockActionHandler) {
          // Route through block action handler as a synthetic "plan_reject_confirmed" action
          await this.blockActionHandler({
            actionId: 'plan_reject_confirmed',
            value: JSON.stringify({ jobId, feedback }),
            blockId: '',
            userId: (user?.id as string) ?? '',
            channelId,
            messageTs,
            triggerId: '',
          });
        }
      }
    }
  }

  private async handleEventsApi(body: Record<string, unknown>): Promise<void> {
    const event = body.event as Record<string, unknown> | undefined;
    if (!event) return;

    const type = event.type as string;

    // Ignore bot messages to prevent loops
    if (event.bot_id || event.subtype) return;

    if (type === 'app_mention' && this.mentionHandler) {
      const userId = event.user as string | undefined;
      const channelId = event.channel as string | undefined;
      const ts = event.ts as string | undefined;
      if (!userId || !channelId || !ts) {
        logger.warn({ type, userId, channelId, ts }, 'app_mention event missing required fields — skipping handler');
        return;
      }
      await this.mentionHandler({
        userId,
        channelId,
        text: (event.text as string) ?? '',
        ts,
      });
      return;
    }

    if (type === 'message') {
      const threadTs = event.thread_ts as string | undefined;
      const channelType = event.channel_type as string | undefined;

      // Threaded reply (existing handler)
      if (threadTs && this.threadMessageHandler) {
        await this.threadMessageHandler({
          userId: (event.user as string) ?? '',
          channelId: (event.channel as string) ?? '',
          text: (event.text as string) ?? '',
          ts: (event.ts as string) ?? '',
          threadTs,
        });
        return;
      }

      // Top-level DM (no thread)
      if (channelType === 'im' && !threadTs && this.directMessageHandler) {
        const userId = event.user as string | undefined;
        const channelId = event.channel as string | undefined;
        const ts = event.ts as string | undefined;
        if (!userId || !channelId || !ts) {
          logger.warn({ type, userId, channelId, ts }, 'DM event missing required fields — skipping handler');
          return;
        }
        await this.directMessageHandler({
          userId,
          channelId,
          text: (event.text as string) ?? '',
          ts,
        });
        return;
      }
    }
  }

  async connect(): Promise<void> {
    try {
      await this.socket.start();
      this.connected = true;
      logger.info('Slack Socket Mode connection started');
    } catch (err) {
      this.connected = false;
      logger.error({ err }, 'Failed to start Slack Socket Mode connection');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.socket.disconnect();
      this.connected = false;
      logger.info('Slack Socket Mode disconnected cleanly');
    } catch (err) {
      logger.error({ err }, 'Error disconnecting Slack Socket Mode');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Send a message and return the channel ID + timestamp for thread tracking. */
  async sendMessageWithTs(channelId: string, text: string, blocks?: unknown[]): Promise<SlackMessageResult> {
    const result = await this.web.chat.postMessage({
      channel: channelId,
      text,
      ...(blocks && { blocks }),
    });
    const ts = result.ts ?? '';
    logger.info({ channelId, ts }, 'Slack message sent to channel');
    return { channelId, ts };
  }

  async sendMessage(channelId: string, text: string, blocks?: unknown[]): Promise<void> {
    try {
      await this.sendMessageWithTs(channelId, text, blocks);
    } catch (err) {
      logger.error({ err, channelId }, 'Failed to send Slack message');
      throw err;
    }
  }

  /** Send a DM and return message metadata for thread tracking. */
  async sendDMWithTs(slackUserId: string, text: string, blocks?: unknown[]): Promise<SlackMessageResult> {
    const conversation = await this.web.conversations.open({ users: slackUserId });
    const channelId = conversation.channel?.id;
    if (!channelId) {
      throw new Error(`Could not open DM channel for user ${slackUserId}`);
    }
    const result = await this.web.chat.postMessage({
      channel: channelId,
      text,
      ...(blocks && { blocks }),
    });
    const ts = result.ts ?? '';
    logger.info({ slackUserId, channelId, ts }, 'Slack DM sent');
    return { channelId, ts };
  }

  async sendDM(slackUserId: string, text: string, blocks?: unknown[]): Promise<void> {
    try {
      await this.sendDMWithTs(slackUserId, text, blocks);
    } catch (err) {
      logger.error({ err, slackUserId }, 'Failed to send Slack DM');
      throw err;
    }
  }

  /** Update an existing message (e.g. to replace buttons with a status line). */
  async updateMessage(channelId: string, ts: string, text: string, blocks?: unknown[]): Promise<void> {
    try {
      await this.web.chat.update({
        channel: channelId,
        ts,
        text,
        ...(blocks && { blocks }),
      });
      logger.info({ channelId, ts }, 'Slack message updated');
    } catch (err) {
      logger.error({ err, channelId, ts }, 'Failed to update Slack message');
      throw err;
    }
  }

  /** Add an emoji reaction to a message. */
  async addReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.add({
        channel: channelId,
        timestamp: ts,
        name: emoji,
      });
    } catch (err) {
      // already_reacted is not an error
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes('already_reacted')) {
        logger.warn({ err, channelId, ts, emoji }, 'Failed to add Slack reaction');
      }
    }
  }

  /** Reply in a thread. */
  async replyInThread(channelId: string, threadTs: string, text: string, blocks?: unknown[]): Promise<void> {
    try {
      await this.web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
        ...(blocks && { blocks }),
      });
      logger.info({ channelId, threadTs }, 'Slack thread reply sent');
    } catch (err) {
      logger.error({ err, channelId, threadTs }, 'Failed to reply in Slack thread');
      throw err;
    }
  }

  /** Open a modal dialog (used for reject feedback). */
  async openModal(triggerId: string, view: Record<string, unknown>): Promise<void> {
    try {
      await this.web.views.open({
        trigger_id: triggerId,
        view: view as never,
      });
      logger.info({ triggerId }, 'Slack modal opened');
    } catch (err) {
      logger.error({ err, triggerId }, 'Failed to open Slack modal');
      throw err;
    }
  }

  /** Test connectivity by calling auth.test and listing channels. */
  async testConnection(): Promise<{ ok: boolean; botName?: string; channelCount?: number }> {
    const authResult = await this.web.auth.test();
    const channelResult = await this.web.conversations.list({ types: 'public_channel', limit: 200 });
    return {
      ok: true,
      botName: authResult.user,
      channelCount: channelResult.channels?.length ?? 0,
    };
  }
}
