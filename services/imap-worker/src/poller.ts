import { ImapFlow } from 'imapflow';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('imap-poller');

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

export interface RawEmail {
  uid: number;
  source: Buffer;
  messageId: string;
}

export async function pollEmails(config: ImapConfig): Promise<RawEmail[]> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
  });

  const emails: RawEmail[] = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const messages = client.fetch('1:*', {
        uid: true,
        source: true,
        envelope: true,
        flags: true,
      }, { changedSince: BigInt(0) });

      for await (const msg of messages) {
        // Only process unseen messages
        if (msg.flags && !msg.flags.has('\\Seen')) {
          emails.push({
            uid: msg.uid,
            source: msg.source!,
            messageId: msg.envelope?.messageId ?? `uid-${msg.uid}`,
          });
        }
      }
    } finally {
      lock.release();
    }

    // Mark fetched messages as seen
    if (emails.length > 0) {
      const lock2 = await client.getMailboxLock('INBOX');
      try {
        const uids = emails.map((e) => e.uid);
        await client.messageFlagsAdd({ uid: uids.join(',') }, ['\\Seen'], { uid: true });
      } finally {
        lock2.release();
      }
    }

    logger.info({ count: emails.length }, 'Polled emails');
  } catch (err) {
    logger.error({ err }, 'IMAP poll failed');
    throw err;
  } finally {
    await client.logout().catch(() => {});
  }

  return emails;
}
