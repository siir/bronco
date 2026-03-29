import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('notifier-pushover');

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

export interface PushoverNotifierConfig {
  appToken: string;
  userKey: string;
}

/** Priority levels: -2 lowest, -1 low, 0 normal, 1 high, 2 emergency */
type PushoverPriority = -2 | -1 | 0 | 1 | 2;

export class PushoverNotifier {
  private appToken: string;
  private userKey: string;

  constructor(config: PushoverNotifierConfig) {
    this.appToken = config.appToken;
    this.userKey = config.userKey;
  }

  async send(
    title: string,
    message: string,
    priority: PushoverPriority = 0,
  ): Promise<void> {
    try {
      const body: Record<string, string | number> = {
        token: this.appToken,
        user: this.userKey,
        title,
        message,
        priority,
      };

      // Emergency priority requires retry/expire params
      if (priority === 2) {
        body.retry = 60;
        body.expire = 300;
      }

      const response = await fetch(PUSHOVER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, 'Pushover API error');
        return;
      }

      logger.info({ title }, 'Pushover notification sent');
    } catch (err) {
      logger.error({ err, title }, 'Failed to send Pushover notification');
    }
  }
}
