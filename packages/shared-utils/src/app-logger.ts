import type pino from 'pino';
import { createLogger } from './logger.js';

export interface AppLogEntry {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  service: string;
  message: string;
  context?: Record<string, unknown>;
  entityId?: string;
  entityType?: string;
  error?: string;
}

export type AppLogWriter = (entry: AppLogEntry) => Promise<void>;

/**
 * Application logger that writes structured logs to both stderr (Pino)
 * and a persistent store (e.g. PostgreSQL via a writer callback).
 *
 * The writer is injected so this utility has no dependency on Prisma.
 * Each service provides its own writer backed by its db connection.
 */
export class AppLogger {
  private pino: pino.Logger;
  private writer: AppLogWriter | null = null;
  private service: string;
  private buffer: AppLogEntry[] = [];
  private flushing = false;
  private bufferOverflowWarned = false;
  private backpressureOverflowWarned = false;
  /** Number of DB writes currently in-flight (for backpressure). */
  private inflight = 0;
  /** Maximum concurrent DB writes allowed. */
  private static readonly MAX_CONCURRENCY = 10;

  constructor(service: string) {
    this.service = service;
    this.pino = createLogger(service, { teeToDb: false });
  }

  /** Attach a writer (call once after db is ready). Flushes buffered entries. */
  setWriter(writer: AppLogWriter): void {
    this.writer = writer;
    if (this.buffer.length > 0) {
      this.flush();
    }
  }

  debug(message: string, context?: Record<string, unknown>, entityId?: string, entityType?: string): void {
    this.pino.debug(context ?? {}, message);
    this.write({ level: 'DEBUG', service: this.service, message, context, entityId, entityType });
  }

  info(message: string, context?: Record<string, unknown>, entityId?: string, entityType?: string): void {
    this.pino.info(context ?? {}, message);
    this.write({ level: 'INFO', service: this.service, message, context, entityId, entityType });
  }

  warn(message: string, context?: Record<string, unknown>, entityId?: string, entityType?: string): void {
    this.pino.warn(context ?? {}, message);
    this.write({ level: 'WARN', service: this.service, message, context, entityId, entityType });
  }

  error(message: string, context?: Record<string, unknown>, entityId?: string, entityType?: string): void {
    this.pino.error(context ?? {}, message);
    const errorStr = context?.err
      ? (context.err instanceof Error ? context.err.stack ?? context.err.message : String(context.err))
      : undefined;
    this.write({ level: 'ERROR', service: this.service, message, context, entityId, entityType, error: errorStr });
  }

  private write(entry: AppLogEntry): void {
    // Defensive: if entityId is set but entityType is missing, the DB check constraint
    // (app_logs_entity_consistency_check) will reject the row. Clear both so the log
    // entry persists without entity linking, and warn so the caller can be fixed.
    if (entry.entityId && !entry.entityType) {
      this.pino.warn(
        { entityId: entry.entityId, service: entry.service },
        'AppLogger: entityId provided without entityType — clearing entityId to satisfy DB constraint. Fix the caller.',
      );
      entry.entityId = undefined;
      entry.entityType = undefined;
    }
    if (!this.writer) {
      this.buffer.push(entry);
      // Cap buffer at 500 to avoid unbounded memory usage
      if (this.buffer.length > 500) {
        this.buffer.shift();
        if (!this.bufferOverflowWarned) {
          this.bufferOverflowWarned = true;
          this.pino.warn('AppLogger buffer overflow — oldest entries dropped. Is the DB writer initialized?');
        }
      }
      return;
    }
    // Backpressure: if too many writes are in-flight, buffer instead of firing another
    if (this.inflight >= AppLogger.MAX_CONCURRENCY) {
      this.buffer.push(entry);
      // Apply the same 500-entry cap when buffering due to backpressure
      if (this.buffer.length > 500) {
        this.buffer.shift();
        if (!this.backpressureOverflowWarned) {
          this.backpressureOverflowWarned = true;
          this.pino.warn('AppLogger backpressure buffer overflow — oldest entries dropped. DB writes are saturated.');
        }
      }
      return;
    }
    this.inflight++;
    this.writer(entry)
      .catch((err) => {
        // Avoid recursive logging — only write to stderr
        this.pino.warn({ err }, 'Failed to persist app log entry');
      })
      .finally(() => {
        this.inflight--;
        // Drain one buffered entry if available
        if (this.buffer.length > 0 && this.writer && this.inflight < AppLogger.MAX_CONCURRENCY) {
          const next = this.buffer.shift()!;
          this.write(next);
        }
      });
  }

  private flush(): void {
    if (this.flushing || !this.writer) return;
    this.flushing = true;
    const entries = this.buffer.splice(0);
    this.flushBatched(entries).finally(() => {
      this.flushing = false;
    });
  }

  /**
   * Write buffered entries without exceeding MAX_CONCURRENCY to avoid
   * overwhelming the database connection pool. Flush writes participate in
   * the same inflight accounting as normal writes.
   */
  private async flushBatched(entries: AppLogEntry[]): Promise<void> {
    const writer = this.writer;
    if (!writer || entries.length === 0) return;

    const maxConcurrency = AppLogger.MAX_CONCURRENCY;
    const inFlightPromises = new Set<Promise<void>>();
    let index = 0;

    const launchNext = () => {
      while (index < entries.length && this.inflight < maxConcurrency) {
        const entry = entries[index++];
        this.inflight++;
        const p = writer(entry)
          .catch((err) => {
            this.pino.warn({ err }, 'Failed to persist app log entry during flush');
          })
          .finally(() => {
            this.inflight--;
            inFlightPromises.delete(p);
            // Drain buffered entries (same as write()'s finally)
            if (this.buffer.length > 0 && this.writer && this.inflight < maxConcurrency) {
              const next = this.buffer.shift()!;
              this.write(next);
            }
          });
        inFlightPromises.add(p);
      }
    };

    launchNext();

    while (inFlightPromises.size > 0) {
      await Promise.race(inFlightPromises);
      launchNext();
    }
  }
}

/**
 * Creates an AppLogWriter backed by a Prisma-like client.
 * Uses `any` for the db parameter to avoid coupling shared-utils to Prisma's
 * generated types — each service passes its own PrismaClient instance.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPrismaLogWriter(db: any): AppLogWriter {
  return async (entry: AppLogEntry) => {
    const parentLogId = entry.context?.parentLogId as string | undefined;
    const parentLogType = entry.context?.parentLogType as string | undefined;
    const taskRun = entry.context?.taskRun as number | undefined;
    await db.appLog.create({
      data: {
        level: entry.level,
        service: entry.service,
        message: entry.message,
        context: entry.context ?? undefined,
        entityId: entry.entityId ?? undefined,
        entityType: entry.entityType ?? undefined,
        error: entry.error ?? undefined,
        ...(parentLogId ? { parentLogId } : {}),
        ...(parentLogType ? { parentLogType } : {}),
        ...(taskRun != null ? { taskRun } : {}),
      },
    });
  };
}
