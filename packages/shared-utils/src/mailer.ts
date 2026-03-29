import { createTransport, type Transporter } from 'nodemailer';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('mailer');

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** Display name for the From header. If set, From becomes "Name <address>". */
  fromName?: string;
  secure?: boolean;
}

export interface ReplyOptions {
  to: string;
  subject: string;
  body: string;
  /** Original Message-ID to reply to (sets In-Reply-To header) */
  inReplyTo?: string;
  /** Full reference chain for threading */
  references?: string[];
}

export class Mailer {
  private transport: Transporter;
  private from: string | { name: string; address: string };

  constructor(config: SmtpConfig) {
    this.from = config.fromName
      ? { name: config.fromName, address: config.from }
      : config.from;

    const secure = config.secure ?? config.port === 465;

    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure,
      requireTLS: !secure && config.port === 587,
      auth: {
        user: config.user,
        pass: config.password,
      },
    });
  }

  /**
   * Send a reply email with proper threading headers so the recipient's
   * mail client groups it with the original conversation.
   */
  async sendReply(opts: ReplyOptions): Promise<string | undefined> {
    const headers: Record<string, string> = {};
    if (opts.inReplyTo) {
      headers['In-Reply-To'] = opts.inReplyTo;
    }
    if (opts.references && opts.references.length > 0) {
      headers['References'] = opts.references.join(' ');
    }

    const info = await this.transport.sendMail({
      from: this.from,
      to: opts.to,
      subject: /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}`,
      text: opts.body,
      headers,
    });

    const outboundMessageId = info.messageId as string | undefined;
    logger.info(
      { to: opts.to, subject: opts.subject, messageId: outboundMessageId },
      'Reply email sent',
    );
    return outboundMessageId;
  }

  /** Send a plain outbound email (not a reply — no Re: prefix or threading headers). */
  async send(opts: { to: string; subject: string; body: string }): Promise<string | undefined> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
    });

    const outboundMessageId = info.messageId as string | undefined;
    logger.info(
      { to: opts.to, subject: opts.subject, messageId: outboundMessageId },
      'Email sent',
    );
    return outboundMessageId;
  }

  async verify(): Promise<boolean> {
    try {
      await this.transport.verify();
      return true;
    } catch (err) {
      logger.error({ err }, 'SMTP verification failed');
      return false;
    }
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}
