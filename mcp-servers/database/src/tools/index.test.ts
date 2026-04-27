/**
 * Unit tests for tools/index.ts — registerAllTools
 *
 * No real SQL Server or Postgres DB is used.
 * The mssql driver and shared-utils are mocked via vi.mock().
 * A stubbed PoolManager and AuditLogger are passed in.
 *
 * Coverage:
 *  - All expected tool names are registered (run_query, inspect_schema, list_indexes,
 *    get_blocking_tree, get_wait_stats, get_database_health, list_systems)
 *  - Zod schema rejects missing required fields (systemId not a UUID, query missing, etc.)
 *  - Zod schema rejects out-of-range maxRows
 *  - Zod schema accepts valid input
 *  - Handler returns content array on success
 *  - Handler propagates errors from pool (error thrown → error propagated)
 *  - list_systems handler calls poolManager.listSystems() and serialises the result
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mock mssql (required to import pool-manager transitively)
// ---------------------------------------------------------------------------

vi.mock('mssql', () => {
  const ConnectionPool = vi.fn(function ConnectionPoolMock(this: Record<string, unknown>) {
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
    this.on = vi.fn();
    Object.defineProperty(this, 'connected', { get: () => true, configurable: true });
  }) as unknown as { parseConnectionString: ReturnType<typeof vi.fn> };
  ConnectionPool.parseConnectionString = vi.fn();
  return { default: { ConnectionPool } };
});

// ---------------------------------------------------------------------------
// Mock @bronco/shared-utils
// ---------------------------------------------------------------------------

vi.mock('@bronco/shared-utils', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  decrypt: vi.fn((v: string) => v),
}));

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

/** Stub AuditLogger — log() is a no-op. */
class StubAuditLogger {
  log = vi.fn().mockResolvedValue(undefined);
}

/** Stub PoolManager — getPool() resolves to a fake pool object by default. */
class StubPoolManager {
  getPool = vi.fn().mockResolvedValue({ request: vi.fn() });
  listSystems = vi.fn().mockReturnValue([]);
  getSystemConfig = vi.fn();
  closeAll = vi.fn().mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const { registerAllTools } = await import('./index.js');

// ---------------------------------------------------------------------------
// Helper: create a fresh McpServer with tools registered
// ---------------------------------------------------------------------------

function makeServer() {
  const server = new McpServer({ name: 'test-mcp-db', version: '0.0.1' });
  const pool = new StubPoolManager();
  const audit = new StubAuditLogger();
  registerAllTools(server, pool as never, audit as never);
  return { server, pool, audit };
}

/**
 * Access the private _registeredTools map.
 * This lets us inspect registered tool metadata and call handlers directly
 * without needing a full MCP transport.
 */
function getRegisteredTools(server: McpServer): Record<string, {
  description?: string;
  inputSchema?: ReturnType<typeof z.object>;
  handler: (...args: unknown[]) => unknown;
}> {
  return (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools as never;
}

// ---------------------------------------------------------------------------
// Tests: tool registration
// ---------------------------------------------------------------------------

describe('registerAllTools — tool names', () => {
  it('registers run_query', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(tools['run_query']).toBeDefined();
  });

  it('registers inspect_schema', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(tools['inspect_schema']).toBeDefined();
  });

  it('registers list_indexes', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(tools['list_indexes']).toBeDefined();
  });

  it('registers get_blocking_tree', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(tools['get_blocking_tree']).toBeDefined();
  });

  it('registers get_wait_stats', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(tools['get_wait_stats']).toBeDefined();
  });

  it('registers get_database_health', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(tools['get_database_health']).toBeDefined();
  });

  it('registers list_systems', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(tools['list_systems']).toBeDefined();
  });

  it('registers exactly 7 tools (no extras)', () => {
    const { server } = makeServer();
    const tools = getRegisteredTools(server);
    expect(Object.keys(tools)).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Tests: Zod input validation via inputSchema
// ---------------------------------------------------------------------------

describe('registerAllTools — Zod input validation', () => {
  // Helpers to parse params through the registered schema
  function parseToolInput(server: McpServer, toolName: string, input: unknown) {
    const tool = getRegisteredTools(server)[toolName]!;
    // inputSchema is the raw Zod shape passed to server.tool(); the SDK wraps it.
    // Access it from the registered tool object.
    const schema = (tool as unknown as { inputSchema: z.ZodTypeAny }).inputSchema;
    if (!schema) return { success: true, data: input };
    return schema.safeParse(input);
  }

  // -----------------------------------------------------------------------
  // run_query
  // -----------------------------------------------------------------------

  describe('run_query', () => {
    it('accepts valid input', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        query: 'SELECT 1',
      });
      expect(r.success).toBe(true);
    });

    it('rejects missing systemId', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', { query: 'SELECT 1' });
      expect(r.success).toBe(false);
    });

    it('rejects non-UUID systemId', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', {
        systemId: 'not-a-uuid',
        query: 'SELECT 1',
      });
      expect(r.success).toBe(false);
    });

    it('rejects missing query', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(r.success).toBe(false);
    });

    it('rejects maxRows = 0 (below min)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        query: 'SELECT 1',
        maxRows: 0,
      });
      expect(r.success).toBe(false);
    });

    it('rejects maxRows = 10001 (above max)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        query: 'SELECT 1',
        maxRows: 10001,
      });
      expect(r.success).toBe(false);
    });

    it('accepts maxRows at boundary (1)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        query: 'SELECT 1',
        maxRows: 1,
      });
      expect(r.success).toBe(true);
    });

    it('accepts maxRows at boundary (10000)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        query: 'SELECT 1',
        maxRows: 10000,
      });
      expect(r.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // inspect_schema
  // -----------------------------------------------------------------------

  describe('inspect_schema', () => {
    it('accepts valid input (systemId only)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'inspect_schema', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(r.success).toBe(true);
    });

    it('rejects non-UUID systemId', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'inspect_schema', {
        systemId: 'bad-id',
      });
      expect(r.success).toBe(false);
    });

    it('rejects missing systemId', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'inspect_schema', { objectName: 'users' });
      expect(r.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // list_indexes
  // -----------------------------------------------------------------------

  describe('list_indexes', () => {
    it('accepts valid input (systemId only)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'list_indexes', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(r.success).toBe(true);
    });

    it('rejects missing systemId', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'list_indexes', {});
      expect(r.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // get_blocking_tree
  // -----------------------------------------------------------------------

  describe('get_blocking_tree', () => {
    it('accepts valid input', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_blocking_tree', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(r.success).toBe(true);
    });

    it('rejects non-UUID systemId', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_blocking_tree', { systemId: '123' });
      expect(r.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // get_wait_stats
  // -----------------------------------------------------------------------

  describe('get_wait_stats', () => {
    it('accepts valid input', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_wait_stats', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(r.success).toBe(true);
    });

    it('rejects topN = 0 (below min)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_wait_stats', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        topN: 0,
      });
      expect(r.success).toBe(false);
    });

    it('rejects topN = 101 (above max)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_wait_stats', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        topN: 101,
      });
      expect(r.success).toBe(false);
    });

    it('accepts topN = 100 (at max boundary)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_wait_stats', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        topN: 100,
      });
      expect(r.success).toBe(true);
    });

    it('accepts topN = 1 (at min boundary)', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_wait_stats', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        topN: 1,
      });
      expect(r.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // get_database_health
  // -----------------------------------------------------------------------

  describe('get_database_health', () => {
    it('accepts valid input', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_database_health', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      });
      expect(r.success).toBe(true);
    });

    it('rejects missing systemId', () => {
      const { server } = makeServer();
      const r = parseToolInput(server, 'get_database_health', {});
      expect(r.success).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: handler error propagation (pool throws → handler propagates)
// ---------------------------------------------------------------------------

describe('registerAllTools — handler error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Call a registered handler directly (bypassing MCP transport validation).
   * The handler is the raw async callback passed to server.tool().
   */
  async function callHandler(
    server: McpServer,
    toolName: string,
    params: Record<string, unknown>,
  ) {
    const tool = getRegisteredTools(server)[toolName]!;
    const handler = (tool as unknown as { handler: (p: unknown) => Promise<unknown> }).handler;
    return handler(params);
  }

  it('run_query: handler throws when pool.getPool rejects', async () => {
    const { server, pool } = makeServer();
    pool.getPool.mockRejectedValue(new Error('System not found: unknown-sys'));

    await expect(
      callHandler(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        query: 'SELECT 1',
      }),
    ).rejects.toThrow();
  });

  it('run_query: handler throws when query is blocked by validator', async () => {
    const { server } = makeServer();

    await expect(
      callHandler(server, 'run_query', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        query: 'DROP TABLE users',
      }),
    ).rejects.toThrow(/validation|DROP/i);
  });

  it('inspect_schema: handler throws when pool.getPool rejects', async () => {
    const { server, pool } = makeServer();
    pool.getPool.mockRejectedValue(new Error('Connection pool exhausted'));

    await expect(
      callHandler(server, 'inspect_schema', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
    ).rejects.toThrow();
  });

  it('list_indexes: handler throws when pool.getPool rejects', async () => {
    const { server, pool } = makeServer();
    pool.getPool.mockRejectedValue(new Error('Auth failed'));

    await expect(
      callHandler(server, 'list_indexes', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
    ).rejects.toThrow();
  });

  it('get_blocking_tree: handler throws when pool.getPool rejects', async () => {
    const { server, pool } = makeServer();
    pool.getPool.mockRejectedValue(new Error('Network timeout'));

    await expect(
      callHandler(server, 'get_blocking_tree', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
    ).rejects.toThrow();
  });

  it('get_wait_stats: handler throws when pool.getPool rejects', async () => {
    const { server, pool } = makeServer();
    pool.getPool.mockRejectedValue(new Error('SSL error'));

    await expect(
      callHandler(server, 'get_wait_stats', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
    ).rejects.toThrow();
  });

  it('get_database_health: handler throws when pool.getPool rejects', async () => {
    const { server, pool } = makeServer();
    pool.getPool.mockRejectedValue(new Error('Query timed out'));

    await expect(
      callHandler(server, 'get_database_health', {
        systemId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      }),
    ).rejects.toThrow();
  });

  // -----------------------------------------------------------------------
  // list_systems — success path (no pool connection needed)
  // -----------------------------------------------------------------------

  it('list_systems: handler returns content array with JSON of systems list', async () => {
    const { server, pool } = makeServer();
    const fakeSystems = [
      { id: 'sys-1', name: 'Prod DB', clientId: 'c1', dbEngine: 'MSSQL' },
    ];
    pool.listSystems.mockReturnValue(fakeSystems);

    const result = await callHandler(server, 'list_systems', {}) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result).toHaveProperty('content');
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]!.type).toBe('text');

    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed).toEqual(fakeSystems);
  });

  it('list_systems: calls poolManager.listSystems() exactly once', async () => {
    const { server, pool } = makeServer();
    pool.listSystems.mockReturnValue([]);

    await callHandler(server, 'list_systems', {});

    expect(pool.listSystems).toHaveBeenCalledOnce();
  });

  it('list_systems: handler throws when poolManager.listSystems throws', async () => {
    const { server, pool } = makeServer();
    pool.listSystems.mockImplementation(() => {
      throw new Error('Config reload failed');
    });

    await expect(callHandler(server, 'list_systems', {})).rejects.toThrow('Config reload failed');
  });
});

// ---------------------------------------------------------------------------
// Tests: tool descriptions (basic smoke check)
// ---------------------------------------------------------------------------

describe('registerAllTools — tool descriptions', () => {
  it('run_query has a non-empty description', () => {
    const { server } = makeServer();
    const tool = getRegisteredTools(server)['run_query']!;
    const desc = (tool as unknown as { description?: string }).description;
    expect(typeof desc).toBe('string');
    expect(desc!.length).toBeGreaterThan(0);
  });

  it('list_systems has a non-empty description', () => {
    const { server } = makeServer();
    const tool = getRegisteredTools(server)['list_systems']!;
    const desc = (tool as unknown as { description?: string }).description;
    expect(typeof desc).toBe('string');
    expect(desc!.length).toBeGreaterThan(0);
  });
});
