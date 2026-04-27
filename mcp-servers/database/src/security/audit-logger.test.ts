/**
 * Unit tests for security/audit-logger.ts
 *
 * AuditLogger wraps Pino's createLogger. We capture what it emits to verify:
 *  - The query itself is NOT logged (only its SHA-256 hash) — redaction
 *  - Required fields (systemId, queryHash, toolName, caller) are present
 *  - Optional fields (durationMs, rowCount, error) are included when provided, absent when not
 *  - The log message is "query audit"
 *  - queryHash is a valid 64-char hex string (sha256)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

// We spy on createLogger to intercept what AuditLogger calls on the logger instance.
// Because AuditLogger calls createLogger at module evaluation time, we need to mock
// before importing the module under test.

// Capture logged objects
let loggedObjects: Array<Record<string, unknown>> = [];
let loggedMessages: string[] = [];

// Create a fake pino logger whose .info() captures calls
const fakeLogger = {
  info: vi.fn((obj: Record<string, unknown>, msg: string) => {
    loggedObjects.push(obj);
    loggedMessages.push(msg);
  }),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => fakeLogger),
};

// Mock @bronco/shared-utils before importing AuditLogger
vi.mock('@bronco/shared-utils', () => ({
  createLogger: vi.fn(() => fakeLogger),
}));

// Import after mock is registered
const { AuditLogger } = await import('./audit-logger.js');

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('AuditLogger', () => {
  let auditLogger: InstanceType<typeof AuditLogger>;

  beforeEach(() => {
    loggedObjects = [];
    loggedMessages = [];
    vi.clearAllMocks();
    // Re-wire the mock (clearAllMocks resets call counts but not implementations)
    fakeLogger.info.mockImplementation((obj: Record<string, unknown>, msg: string) => {
      loggedObjects.push(obj);
      loggedMessages.push(msg);
    });
    auditLogger = new AuditLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Basic structure
  // -------------------------------------------------------------------------

  it('calls logger.info once per log() call', async () => {
    await auditLogger.log({
      systemId: 'sys-1',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'mcp:claude-code',
    });

    expect(fakeLogger.info).toHaveBeenCalledTimes(1);
  });

  it('sets message to "query audit"', async () => {
    await auditLogger.log({
      systemId: 'sys-1',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'mcp:claude-code',
    });

    expect(loggedMessages[0]).toBe('query audit');
  });

  // -------------------------------------------------------------------------
  // Query redaction — the raw query must NOT appear in the log object
  // -------------------------------------------------------------------------

  it('does NOT log the raw query text', async () => {
    const query = 'SELECT secret_column FROM secret_table';
    await auditLogger.log({
      systemId: 'sys-1',
      query,
      toolName: 'run_query',
      caller: 'mcp:claude-code',
    });

    const logged = loggedObjects[0]!;
    // The raw query string should not appear as any value in the logged object
    for (const value of Object.values(logged)) {
      expect(String(value)).not.toBe(query);
      expect(String(value)).not.toContain('secret_column');
    }
  });

  it('logs the SHA-256 hash of the query instead', async () => {
    const query = 'SELECT 1 FROM sys.tables';
    await auditLogger.log({
      systemId: 'sys-1',
      query,
      toolName: 'run_query',
      caller: 'mcp:claude-code',
    });

    const logged = loggedObjects[0]!;
    const expectedHash = sha256Hex(query);
    expect(logged['queryHash']).toBe(expectedHash);
  });

  it('queryHash is a 64-character lowercase hex string', async () => {
    await auditLogger.log({
      systemId: 'sys-1',
      query: 'SELECT name FROM sys.databases',
      toolName: 'inspect_schema',
      caller: 'test-caller',
    });

    const logged = loggedObjects[0]!;
    const hash = logged['queryHash'];
    expect(typeof hash).toBe('string');
    expect((hash as string).length).toBe(64);
    expect((hash as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // Required fields
  // -------------------------------------------------------------------------

  it('includes systemId', async () => {
    await auditLogger.log({
      systemId: 'test-system-uuid',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'mcp:claude',
    });
    expect(loggedObjects[0]!['systemId']).toBe('test-system-uuid');
  });

  it('includes toolName', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'inspect_schema',
      caller: 'mcp:claude',
    });
    expect(loggedObjects[0]!['toolName']).toBe('inspect_schema');
  });

  it('includes caller', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'unit-test-caller',
    });
    expect(loggedObjects[0]!['caller']).toBe('unit-test-caller');
  });

  // -------------------------------------------------------------------------
  // Optional fields — present when provided
  // -------------------------------------------------------------------------

  it('includes durationMs when provided', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'test',
      durationMs: 42,
    });
    expect(loggedObjects[0]!['durationMs']).toBe(42);
  });

  it('includes rowCount when provided', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'test',
      rowCount: 100,
    });
    expect(loggedObjects[0]!['rowCount']).toBe(100);
  });

  it('includes error when provided', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'test',
      error: 'Connection timeout',
    });
    expect(loggedObjects[0]!['error']).toBe('Connection timeout');
  });

  // -------------------------------------------------------------------------
  // Optional fields — absent when not provided
  // -------------------------------------------------------------------------

  it('does not include durationMs when not provided', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'test',
    });
    // durationMs should be undefined (not set)
    expect(loggedObjects[0]!['durationMs']).toBeUndefined();
  });

  it('does not include rowCount when not provided', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'test',
    });
    expect(loggedObjects[0]!['rowCount']).toBeUndefined();
  });

  it('does not include error when not provided', async () => {
    await auditLogger.log({
      systemId: 'sys',
      query: 'SELECT 1',
      toolName: 'run_query',
      caller: 'test',
    });
    expect(loggedObjects[0]!['error']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Hash determinism
  // -------------------------------------------------------------------------

  it('produces the same hash for the same query on repeated calls', async () => {
    const query = 'SELECT name FROM sys.tables ORDER BY name';
    await auditLogger.log({ systemId: 'a', query, toolName: 'run_query', caller: 'test' });
    await auditLogger.log({ systemId: 'b', query, toolName: 'run_query', caller: 'test' });

    expect(loggedObjects[0]!['queryHash']).toBe(loggedObjects[1]!['queryHash']);
  });

  it('produces different hashes for different queries', async () => {
    await auditLogger.log({ systemId: 'sys', query: 'SELECT 1', toolName: 'run_query', caller: 'test' });
    await auditLogger.log({ systemId: 'sys', query: 'SELECT 2', toolName: 'run_query', caller: 'test' });

    expect(loggedObjects[0]!['queryHash']).not.toBe(loggedObjects[1]!['queryHash']);
  });

  // -------------------------------------------------------------------------
  // log() returns a resolved promise (does not throw)
  // -------------------------------------------------------------------------

  it('returns a promise that resolves', async () => {
    await expect(
      auditLogger.log({
        systemId: 'sys',
        query: 'SELECT 1',
        toolName: 'run_query',
        caller: 'test',
      }),
    ).resolves.toBeUndefined();
  });
});
