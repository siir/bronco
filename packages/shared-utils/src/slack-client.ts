import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { createLogger } from './logger.js';

const logger = createLogger('slack-client');

export interface SlackClientOpts {
  botToken: string;
  appToken: string;
}

export class SlackClient {
  readonly web: WebClient;
  readonly socket: SocketModeClient;
  private connected = false;

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

  async sendMessage(channelId: string, text: string, blocks?: unknown[]): Promise<string | undefined> {
    try {
      const result = await this.web.chat.postMessage({
        channel: channelId,
        text,
        ...(blocks && { blocks }),
      });
      logger.info({ channelId }, 'Slack message sent to channel');
      return result.ts;
    } catch (err) {
      logger.error({ err, channelId }, 'Failed to send Slack message');
      throw err;
    }
  }

  async sendMessageInThread(channelId: string, threadTs: string, text: string, blocks?: unknown[]): Promise<string | undefined> {
    try {
      const result = await this.web.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
        ...(blocks && { blocks }),
      });
      logger.info({ channelId, threadTs }, 'Slack threaded message sent');
      return result.ts;
    } catch (err) {
      logger.error({ err, channelId, threadTs }, 'Failed to send threaded Slack message');
      throw err;
    }
  }

  async sendDM(slackUserId: string, text: string, blocks?: unknown[]): Promise<void> {
    try {
      const conversation = await this.web.conversations.open({ users: slackUserId });
      const channelId = conversation.channel?.id;
      if (!channelId) {
        throw new Error(`Could not open DM channel for user ${slackUserId}`);
      }
      await this.web.chat.postMessage({
        channel: channelId,
        text,
        ...(blocks && { blocks }),
      });
      logger.info({ slackUserId }, 'Slack DM sent');
    } catch (err) {
      logger.error({ err, slackUserId }, 'Failed to send Slack DM');
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
