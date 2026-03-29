import { createHash } from 'node:crypto';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('audit-logger');

export class AuditLogger {
  async log(entry: {
    systemId: string;
    query: string;
    toolName: string;
    caller: string;
    durationMs?: number;
    rowCount?: number;
    error?: string;
  }): Promise<void> {
    const queryHash = createHash('sha256')
      .update(entry.query)
      .digest('hex');

    logger.info({
      systemId: entry.systemId,
      queryHash,
      toolName: entry.toolName,
      caller: entry.caller,
      durationMs: entry.durationMs,
      rowCount: entry.rowCount,
      error: entry.error,
    }, 'query audit');
  }
}
