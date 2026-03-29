import { createTransport, type Transporter } from 'nodemailer';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('notifier-email');

export interface EmailNotifierConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  to: string;
}

export class EmailNotifier {
  private transport: Transporter;
  private from: string;
  private to: string;

  constructor(config: EmailNotifierConfig) {
    this.from = config.from;
    this.to = config.to;

    const secure = config.port === 465;
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure,
      requireTLS: !secure && config.port === 587,
      auth: { user: config.user, pass: config.password },
    });
  }

  async send(subject: string, body: string): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: this.to,
        subject,
        text: body,
      });
      logger.info({ to: this.to, subject }, 'Alert email sent');
    } catch (err) {
      logger.error({ err, to: this.to, subject }, 'Failed to send alert email');
    }
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

  close(): void {
    this.transport.close();
  }
}
