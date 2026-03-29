import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogger, setGlobalLogWriter, _resetGlobalLogWriter, _sanitizeContext } from './logger.js';
import type { AppLogWriter, AppLogEntry } from './app-logger.js';

/** Collect entries written by the global tee writer. */
function mockWriter(): { entries: AppLogEntry[]; writer: AppLogWriter } {
  const entries: AppLogEntry[] = [];
  const writer: AppLogWriter = async (entry) => {
    entries.push(entry);
  };
  return { entries, writer };
}

/**
 * Helper: write a log line and wait for the tee Transform to process it.
 * Pino serialises → Transform parses → writeToDb fires async.
 * We need a small delay for the async chain to settle.
 */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  _resetGlobalLogWriter();
});

describe('createLogger tee behaviour', () => {
  it('tees WARN entries to the global writer', async () => {
    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    log.warn('something bad');
    await settle();

    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe('WARN');
    expect(entries[0].service).toBe('test-svc');
    expect(entries[0].message).toBe('something bad');
  });

  it('tees ERROR entries to the global writer', async () => {
    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    log.error({ err: new Error('boom') }, 'crash');
    await settle();

    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe('ERROR');
    expect(entries[0].message).toBe('crash');
    expect(entries[0].error).toContain('boom');
  });

  it('does NOT tee DEBUG or INFO entries', async () => {
    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    log.level = 'debug';
    log.debug('debug msg');
    log.info('info msg');
    await settle();

    expect(entries.length).toBe(0);
  });

  it('does NOT tee when teeToDb is false', async () => {
    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc', { teeToDb: false });
    log.warn('should not tee');
    await settle();

    expect(entries.length).toBe(0);
  });
});

describe('setGlobalLogWriter buffer flush', () => {
  it('buffers entries before writer is set, then flushes', async () => {
    const log = createLogger('test-svc');
    // Log before writer is set — entries go to buffer
    log.warn('buffered-1');
    log.error('buffered-2');
    await settle();

    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);
    await settle();

    expect(entries.length).toBe(2);
    expect(entries[0].message).toBe('buffered-1');
    expect(entries[1].message).toBe('buffered-2');
  });

  it('drops entries beyond MAX_BUFFER (200)', async () => {
    const log = createLogger('test-svc');
    for (let i = 0; i < 220; i++) {
      log.warn(`msg-${i}`);
    }
    await settle();

    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);
    await settle(200);

    // Buffer capped at 200
    expect(entries.length).toBe(200);
  });
});

describe('backpressure', () => {
  it('buffers when MAX_CONCURRENCY (10) writes are inflight', async () => {
    const resolvers: Array<() => void> = [];
    const received: AppLogEntry[] = [];
    // Writer that blocks until manually resolved
    const writer: AppLogWriter = async (entry) => {
      received.push(entry);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    };
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    // Fire 15 warnings — first 10 should be inflight, next 5 buffered
    for (let i = 0; i < 15; i++) {
      log.warn(`msg-${i}`);
    }
    await settle();

    // 10 are inflight (waiting on resolvers), 5 are buffered
    expect(resolvers.length).toBe(10);

    // Resolve one — should drain one from buffer
    resolvers[0]();
    await settle();
    expect(resolvers.length).toBe(11);

    // Resolve all remaining, including new resolvers created as
    // buffered entries are drained
    let resolvedIndex = 1; // resolvers[0] already resolved above
    while (received.length < 15) {
      const currentLength = resolvers.length;
      for (; resolvedIndex < currentLength; resolvedIndex++) {
        resolvers[resolvedIndex]();
      }
      await settle();
    }

    expect(received.length).toBe(15);
  });
});

describe('_sanitizeContext (direct)', () => {
  it('returns undefined when only Pino internal keys are present', () => {
    const result = _sanitizeContext({ level: 40, time: 123, pid: 1, hostname: 'h', name: 'n', msg: 'm', v: 1 });
    expect(result).toBeUndefined();
  });

  it('returns _circular fallback when context has true circular refs', () => {
    const circular: Record<string, unknown> = { level: 40, customKey: 'val' };
    circular.self = circular;
    const result = _sanitizeContext(circular);
    expect(result).toBeDefined();
    expect(result!._circular).toBe(true);
    expect(result!._keys).toContain('customKey');
    expect(result!._keys).toContain('self');
  });

  it('truncates context exceeding 8KB', () => {
    const result = _sanitizeContext({ level: 40, bigField: 'x'.repeat(10000) });
    expect(result).toBeDefined();
    expect(result!._truncated).toBe(true);
    expect(typeof result!._preview).toBe('string');
    expect((result!._preview as string).length).toBe(8192);
  });
});

describe('sanitizeContext (via tee)', () => {
  it('strips Pino internal keys from context', async () => {
    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    log.warn({ customField: 'hello', anotherField: 42 }, 'with context');
    await settle();

    expect(entries.length).toBe(1);
    const ctx = entries[0].context;
    expect(ctx).toBeDefined();
    // Should have custom fields but not Pino internals
    expect(ctx!.customField).toBe('hello');
    expect(ctx!.anotherField).toBe(42);
    expect(ctx!.level).toBeUndefined();
    expect(ctx!.time).toBeUndefined();
    expect(ctx!.pid).toBeUndefined();
    expect(ctx!.hostname).toBeUndefined();
    expect(ctx!.name).toBeUndefined();
    expect(ctx!.msg).toBeUndefined();
  });

  it('handles circular references without crashing', async () => {
    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    log.warn(circular, 'circular context');
    await settle();

    // Pino's own serializer replaces circular refs with "[Circular]" before
    // the Transform sees it, so sanitizeContext receives a non-circular object.
    // The entry should still be written successfully.
    expect(entries.length).toBe(1);
    const ctx = entries[0].context;
    expect(ctx).toBeDefined();
    expect(ctx!.a).toBe(1);
    // Pino resolves circular to string — verify no crash either way
    expect(ctx!.self).toBeDefined();
  });

  it('truncates context exceeding 8KB', async () => {
    const { entries, writer } = mockWriter();
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    log.warn({ bigField: 'x'.repeat(10000) }, 'large context');
    await settle();

    expect(entries.length).toBe(1);
    const ctx = entries[0].context;
    expect(ctx).toBeDefined();
    expect(ctx!._truncated).toBe(true);
    expect(typeof ctx!._preview).toBe('string');
  });
});

describe('writer failure handling', () => {
  it('silently drops entries when writer throws', async () => {
    const failWriter: AppLogWriter = async () => {
      throw new Error('DB down');
    };
    setGlobalLogWriter(failWriter);

    const log = createLogger('test-svc');
    // Should not throw or crash
    log.warn('will fail');
    log.error('also fails');
    await settle();

    // No crash — test passes if we reach here
    expect(true).toBe(true);
  });

  it('continues draining after writer failures', async () => {
    let callCount = 0;
    const received: AppLogEntry[] = [];
    const writer: AppLogWriter = async (entry) => {
      callCount++;
      if (callCount <= 2) throw new Error('transient');
      received.push(entry);
    };
    setGlobalLogWriter(writer);

    const log = createLogger('test-svc');
    log.warn('fail-1');
    log.warn('fail-2');
    log.warn('succeed-3');
    await settle(200);

    // Third entry should succeed even after first two fail
    expect(received.length).toBe(1);
    expect(received[0].message).toBe('succeed-3');
  });
});
