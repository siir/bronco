import { Transform } from 'node:stream';
import pino from 'pino';
import type { AppLogWriter, AppLogEntry } from './app-logger.js';

let globalWriter: AppLogWriter | null = null;
let globalWriterBuffer: AppLogEntry[] = [];
let inflight = 0;
const MAX_CONCURRENCY = 10;
const MAX_BUFFER = 200;

/** Internal Pino fields to strip from the context object sent to the DB. */
const PINO_INTERNAL_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'name', 'msg', 'v', 'err']);

/**
 * Set the global DB writer for all Pino loggers created via `createLogger()`.
 * Call once per service during startup after Prisma is ready.
 * Flushes any entries buffered before the writer was available.
 */
export function setGlobalLogWriter(writer: AppLogWriter): void {
  globalWriter = writer;
  if (globalWriterBuffer.length > 0) {
    const buffered = globalWriterBuffer.splice(0);
    for (const entry of buffered) {
      writeToDb(entry);
    }
  }
}

/** Exported for testing only. */
export function _sanitizeContext(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  return sanitizeContext(parsed);
}

function sanitizeContext(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  const ctx: Record<string, unknown> = {};
  let hasKeys = false;
  for (const [key, value] of Object.entries(parsed)) {
    if (PINO_INTERNAL_KEYS.has(key)) continue;
    // Skip large binary/buffer-like fields
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) continue;
    ctx[key] = value;
    hasKeys = true;
  }
  if (!hasKeys) return undefined;
  // Truncate serialized context to 8KB to avoid oversized DB writes
  let serialized: string;
  try {
    serialized = JSON.stringify(ctx);
  } catch {
    // Circular references or other serialization failures
    return { _circular: true, _keys: Object.keys(ctx) };
  }
  if (serialized.length > 8192) {
    return { _truncated: true, _preview: serialized.slice(0, 8192) };
  }
  return ctx;
}

function writeToDb(entry: AppLogEntry): void {
  if (!globalWriter) {
    if (globalWriterBuffer.length < MAX_BUFFER) {
      globalWriterBuffer.push(entry);
    }
    return;
  }
  if (inflight >= MAX_CONCURRENCY) {
    if (globalWriterBuffer.length < MAX_BUFFER) {
      globalWriterBuffer.push(entry);
    }
    return;
  }
  inflight++;
  globalWriter(entry)
    .catch(() => {
      // Silently drop — cannot log about logging failures to avoid recursion
    })
    .finally(() => {
      inflight--;
      // Drain one buffered entry if available
      if (globalWriterBuffer.length > 0 && globalWriter && inflight < MAX_CONCURRENCY) {
        const next = globalWriterBuffer.shift()!;
        writeToDb(next);
      }
    });
}

function createTeeDestination(name: string): pino.DestinationStream {
  return new Transform({
    objectMode: false,
    transform(chunk: Buffer, _encoding, callback) {
      // Always write to stderr
      process.stderr.write(chunk);

      // Short-circuit: only parse if this looks like a WARN (40), ERROR (50+) or
      // FATAL (60) line. Pino serializes level as "level":NN with no spaces. All
      // levels < 40 start with a digit < 4, so checking for "level":4, "level":5
      // or "level":6 covers WARN/ERROR/FATAL without a full JSON.parse on every line.
      const raw = chunk.toString();
      if (raw.includes('"level":4') || raw.includes('"level":5') || raw.includes('"level":6')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.level >= 40) {
            const entry: AppLogEntry = {
              level: parsed.level >= 50 ? 'ERROR' : 'WARN',
              service: parsed.name ?? name,
              message: parsed.msg ?? '',
              context: sanitizeContext(parsed),
              error: parsed.err?.stack ?? parsed.err?.message ?? undefined,
            };
            writeToDb(entry);
          }
        } catch {
          // JSON parse failure — just pass through
        }
      }

      callback();
    },
  });
}

export interface CreateLoggerOptions {
  /** When false, skip the global DB writer tee (stderr only). Default: true. */
  teeToDb?: boolean;
}

export function createLogger(name: string, options?: CreateLoggerOptions): pino.Logger {
  const tee = options?.teeToDb !== false;
  if (tee) {
    return pino({
      name,
      level: process.env.LOG_LEVEL ?? 'info',
    }, createTeeDestination(name));
  }
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? 'info',
  }, pino.destination(2));
}

/** Reset module state — test use only. */
export function _resetGlobalLogWriter(): void {
  globalWriter = null;
  globalWriterBuffer = [];
  inflight = 0;
}
