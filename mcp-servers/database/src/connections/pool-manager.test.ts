/**
 * Unit tests for connections/pool-manager.ts
 *
 * The mssql driver is mocked so no real SQL Server connection is attempted.
 * Coverage:
 *  - buildMssqlConfig for MSSQL and AZURE_SQL_MI (host+port and connection string paths)
 *  - Unsupported dbEngine throws
 *  - Pool reuse on cache hit (connected pool)
 *  - Pool recreation on disconnected pool
 *  - getSystemConfig returns correct shape
 *  - listSystems returns all configs
 *  - reloadSystems closes pools for removed/changed systems
 *  - onMissLoader is called when system is unknown
 *  - closeAll clears pools and stops cleanup interval
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SystemConfigEntry } from '../config.js';

// ---------------------------------------------------------------------------
// Mock mssql
// ---------------------------------------------------------------------------

const mockPoolConnect = vi.fn().mockResolvedValue(undefined);
const mockPoolClose = vi.fn().mockResolvedValue(undefined);
const mockPoolOn = vi.fn();
const mockParseConnectionString = vi.fn((cs: string) => {
  // Simple stub: return parsed object from a fake ADO.NET-style string
  return { server: 'parsed-server', port: 1433, database: 'parsedDb', user: 'sa', password: 'pw' };
});

// Mutable state read by the `connected` getter on every constructed pool.
// Tests toggle this to simulate disconnected pools — the getter must be
// re-invoked per access (NOT captured at construction time), so we attach
// it via Object.defineProperty on each new instance.
let poolConnectedState = true;

function applyMockPoolShape(target: Record<string, unknown>): void {
  target.connect = mockPoolConnect;
  target.close = mockPoolClose;
  target.on = mockPoolOn;
  Object.defineProperty(target, 'connected', {
    get: () => poolConnectedState,
    enumerable: true,
    configurable: true,
  });
}

vi.mock('mssql', () => {
  // Vitest 4 requires `function` keyword for `new`-able mocks; arrow-body
  // mockImplementations are flagged as non-constructors and throw on `new`.
  const ConnectionPool = vi.fn(function ConnectionPoolMock(this: Record<string, unknown>) {
    applyMockPoolShape(this);
  }) as unknown as { parseConnectionString: typeof mockParseConnectionString };
  ConnectionPool.parseConnectionString = mockParseConnectionString;
  return { default: { ConnectionPool } };
});

// Mock @bronco/shared-utils logger
vi.mock('@bronco/shared-utils', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import after mocks
const { PoolManager } = await import('./pool-manager.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SystemConfigEntry> = {}): SystemConfigEntry {
  return {
    id: 'test-id-1',
    clientId: 'client-1',
    clientName: 'Test Client',
    clientCode: 'TC',
    name: 'Test System',
    dbEngine: 'MSSQL',
    host: 'sql.test.local',
    port: 1433,
    connectionString: null,
    instanceName: null,
    defaultDatabase: 'TestDb',
    authMethod: 'SQL_AUTH',
    username: 'sa',
    password: 'secret',
    useTls: false,
    trustServerCert: true,
    connectionTimeout: 15000,
    requestTimeout: 30000,
    maxPoolSize: 10,
    environment: 'PRODUCTION',
    ...overrides,
  };
}

function makeAzureMiConfig(overrides: Partial<SystemConfigEntry> = {}): SystemConfigEntry {
  return makeConfig({
    id: 'azure-id-1',
    dbEngine: 'AZURE_SQL_MI',
    host: 'instance.abc123.database.windows.net',
    port: 3342,
    connectionString: null,
    useTls: true,
    trustServerCert: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PoolManager', () => {
  beforeEach(() => {
    poolConnectedState = true;
    vi.clearAllMocks();
    mockPoolConnect.mockResolvedValue(undefined);
    mockPoolClose.mockResolvedValue(undefined);
    mockParseConnectionString.mockReturnValue({
      server: 'parsed-server',
      port: 1433,
      database: 'parsedDb',
      user: 'sa',
      password: 'pw',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / listSystems
  // -------------------------------------------------------------------------

  it('listSystems returns all loaded systems', () => {
    const systems = [makeConfig({ id: 'a' }), makeConfig({ id: 'b', name: 'Second' })];
    const manager = new PoolManager(systems);
    const list = manager.listSystems();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id)).toContain('a');
    expect(list.map((s) => s.id)).toContain('b');
    manager.closeAll();
  });

  it('listSystems returns correct shape fields', () => {
    const cfg = makeConfig({ id: 'shape-test', clientCode: 'XYZ', environment: 'STAGING' });
    const manager = new PoolManager([cfg]);
    const [item] = manager.listSystems();
    expect(item).toMatchObject({
      id: 'shape-test',
      name: cfg.name,
      clientId: cfg.clientId,
      clientName: cfg.clientName,
      clientCode: 'XYZ',
      dbEngine: 'MSSQL',
      environment: 'STAGING',
      host: cfg.host,
      usesConnectionString: false,
    });
    manager.closeAll();
  });

  it('usesConnectionString is true when connectionString is set', () => {
    const cfg = makeAzureMiConfig({ connectionString: 'Server=x;Database=y;' });
    const manager = new PoolManager([cfg]);
    const [item] = manager.listSystems();
    expect(item.usesConnectionString).toBe(true);
    manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // getSystemConfig
  // -------------------------------------------------------------------------

  it('getSystemConfig returns config for known systemId', () => {
    const cfg = makeConfig({ id: 'cfg-test' });
    const manager = new PoolManager([cfg]);
    const result = manager.getSystemConfig('cfg-test');
    expect(result.id).toBe('cfg-test');
    expect(result.host).toBe(cfg.host);
    expect(result.password).toBe(cfg.password);
    manager.closeAll();
  });

  it('getSystemConfig throws for unknown systemId', () => {
    const manager = new PoolManager([]);
    expect(() => manager.getSystemConfig('does-not-exist')).toThrow('System not found');
    manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // buildMssqlConfig — MSSQL (on-prem)
  // -------------------------------------------------------------------------

  it('getPool creates pool with MSSQL host+port config', async () => {
    const mssql = (await import('mssql')).default;
    const cfg = makeConfig({ id: 'mssql-test' });
    const manager = new PoolManager([cfg]);

    await manager.getPool('mssql-test');

    expect(mssql.ConnectionPool).toHaveBeenCalledOnce();
    const constructorArg = (mssql.ConnectionPool as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(constructorArg['server']).toBe(cfg.host);
    expect(constructorArg['port']).toBe(cfg.port);
    expect(constructorArg['database']).toBe(cfg.defaultDatabase);
    expect(constructorArg['user']).toBe(cfg.username);
    expect(constructorArg['password']).toBe(cfg.password);
    expect((constructorArg['options'] as Record<string, unknown>)['encrypt']).toBe(cfg.useTls);
    expect((constructorArg['options'] as Record<string, unknown>)['trustServerCertificate']).toBe(cfg.trustServerCert);
    expect((constructorArg['pool'] as Record<string, unknown>)['max']).toBe(cfg.maxPoolSize);

    await manager.closeAll();
  });

  it('MSSQL config uses instanceName when provided', async () => {
    const mssql = (await import('mssql')).default;
    const cfg = makeConfig({ id: 'named-instance', instanceName: 'SQLEXPRESS' });
    const manager = new PoolManager([cfg]);

    await manager.getPool('named-instance');

    const constructorArg = (mssql.ConnectionPool as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect((constructorArg['options'] as Record<string, unknown>)['instanceName']).toBe('SQLEXPRESS');

    await manager.closeAll();
  });

  it('MSSQL config defaults database to "master" when defaultDatabase is null', async () => {
    const mssql = (await import('mssql')).default;
    const cfg = makeConfig({ id: 'no-db', defaultDatabase: null });
    const manager = new PoolManager([cfg]);

    await manager.getPool('no-db');

    const constructorArg = (mssql.ConnectionPool as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(constructorArg['database']).toBe('master');

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // buildMssqlConfig — AZURE_SQL_MI (host+port path)
  // -------------------------------------------------------------------------

  it('getPool creates pool with AZURE_SQL_MI host+port config', async () => {
    const mssql = (await import('mssql')).default;
    const cfg = makeAzureMiConfig({ id: 'azure-mi-hp' });
    const manager = new PoolManager([cfg]);

    await manager.getPool('azure-mi-hp');

    const constructorArg = (mssql.ConnectionPool as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(constructorArg['server']).toBe(cfg.host);
    expect(constructorArg['port']).toBe(cfg.port);
    // Azure MI always forces encrypt: true regardless of config
    expect((constructorArg['options'] as Record<string, unknown>)['encrypt']).toBe(true);
    // Azure MI always sets trustServerCertificate: false for real cert validation
    expect((constructorArg['options'] as Record<string, unknown>)['trustServerCertificate']).toBe(false);

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // buildMssqlConfig — AZURE_SQL_MI (connection string path)
  // -------------------------------------------------------------------------

  it('getPool uses parseConnectionString when connectionString is set', async () => {
    const mssql = (await import('mssql')).default;
    const connString = 'Server=tcp:my.mi.db.windows.net,3342;Database=mydb;User Id=sa;Password=pw;Encrypt=True;';
    const cfg = makeAzureMiConfig({ id: 'azure-mi-cs', connectionString: connString });
    const manager = new PoolManager([cfg]);

    await manager.getPool('azure-mi-cs');

    expect(mssql.ConnectionPool.parseConnectionString).toHaveBeenCalledWith(connString);
    // Pool should still be created
    expect(mssql.ConnectionPool).toHaveBeenCalledOnce();

    await manager.closeAll();
  });

  it('connection string path merges pool settings from config', async () => {
    const mssql = (await import('mssql')).default;
    const cfg = makeAzureMiConfig({
      id: 'azure-mi-cs-pool',
      connectionString: 'Server=x;Database=y;',
      maxPoolSize: 25,
    });
    const manager = new PoolManager([cfg]);

    await manager.getPool('azure-mi-cs-pool');

    const constructorArg = (mssql.ConnectionPool as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect((constructorArg['pool'] as Record<string, unknown>)['max']).toBe(25);

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // Unsupported dbEngine
  // -------------------------------------------------------------------------

  it('getPool throws for unsupported dbEngine (POSTGRESQL)', async () => {
    const cfg = makeConfig({ id: 'pg-test', dbEngine: 'POSTGRESQL' as 'MSSQL' });
    const manager = new PoolManager([cfg]);

    await expect(manager.getPool('pg-test')).rejects.toThrow(/Unsupported dbEngine/);

    await manager.closeAll();
  });

  it('getPool throws for unsupported dbEngine (MYSQL)', async () => {
    const cfg = makeConfig({ id: 'mysql-test', dbEngine: 'MYSQL' as 'MSSQL' });
    const manager = new PoolManager([cfg]);

    await expect(manager.getPool('mysql-test')).rejects.toThrow(/Unsupported dbEngine/);

    await manager.closeAll();
  });

  it('unsupported dbEngine error message includes the engine name', async () => {
    const cfg = makeConfig({ id: 'pg-msg', dbEngine: 'POSTGRESQL' as 'MSSQL' });
    const manager = new PoolManager([cfg]);

    await expect(manager.getPool('pg-msg')).rejects.toThrow(/POSTGRESQL/);

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // Pool reuse on cache hit
  // -------------------------------------------------------------------------

  it('returns the same pool object on a second getPool call (cache hit)', async () => {
    const mssql = (await import('mssql')).default;
    const cfg = makeConfig({ id: 'reuse-test' });
    const manager = new PoolManager([cfg]);

    const pool1 = await manager.getPool('reuse-test');
    const pool2 = await manager.getPool('reuse-test');

    expect(pool1).toBe(pool2);
    // ConnectionPool constructor only called once
    expect(mssql.ConnectionPool).toHaveBeenCalledOnce();

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // Pool recreation on disconnected pool
  // -------------------------------------------------------------------------

  it('recreates pool when cached pool is disconnected', async () => {
    const mssql = (await import('mssql')).default;
    const cfg = makeConfig({ id: 'reconnect-test' });
    const manager = new PoolManager([cfg]);

    // First call — pool connected
    await manager.getPool('reconnect-test');
    expect(mssql.ConnectionPool).toHaveBeenCalledTimes(1);

    // Simulate disconnected state
    poolConnectedState = false;

    // Second call — should create a new pool
    await manager.getPool('reconnect-test');
    expect(mssql.ConnectionPool).toHaveBeenCalledTimes(2);

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // onMissLoader — called when system is unknown
  // -------------------------------------------------------------------------

  it('calls onMissLoader when systemId is not in cache', async () => {
    const cfg = makeConfig({ id: 'dynamic-system' });
    const manager = new PoolManager([]); // start empty

    const loader = vi.fn().mockResolvedValue([cfg]);
    manager.setOnMissLoader(loader);

    await manager.getPool('dynamic-system');

    expect(loader).toHaveBeenCalledOnce();

    await manager.closeAll();
  });

  it('does not call onMissLoader when system is already in cache', async () => {
    const cfg = makeConfig({ id: 'cached-system' });
    const manager = new PoolManager([cfg]);

    const loader = vi.fn().mockResolvedValue([cfg]);
    manager.setOnMissLoader(loader);

    await manager.getPool('cached-system');

    expect(loader).not.toHaveBeenCalled();

    await manager.closeAll();
  });

  it('throws System not found when onMissLoader returns no matching system', async () => {
    const manager = new PoolManager([]);
    const loader = vi.fn().mockResolvedValue([]); // returns empty — system still not found
    manager.setOnMissLoader(loader);

    await expect(manager.getPool('ghost-system')).rejects.toThrow('System not found');

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // reloadSystems
  // -------------------------------------------------------------------------

  it('reloadSystems replaces configs', async () => {
    const oldCfg = makeConfig({ id: 'sys-old', name: 'Old' });
    const manager = new PoolManager([oldCfg]);

    const newCfg = makeConfig({ id: 'sys-new', name: 'New' });
    await manager.reloadSystems([newCfg]);

    const list = manager.listSystems();
    expect(list.map((s) => s.id)).toContain('sys-new');
    expect(list.map((s) => s.id)).not.toContain('sys-old');

    await manager.closeAll();
  });

  it('reloadSystems closes pools for removed systems', async () => {
    const cfg = makeConfig({ id: 'to-remove' });
    const manager = new PoolManager([cfg]);

    // Create pool
    await manager.getPool('to-remove');

    // Reload without the system
    await manager.reloadSystems([]);

    // Pool should have been closed
    expect(mockPoolClose).toHaveBeenCalled();

    await manager.closeAll();
  });

  it('reloadSystems closes pools for changed systems', async () => {
    const cfg = makeConfig({ id: 'to-change', host: 'old-host' });
    const manager = new PoolManager([cfg]);

    // Create pool
    await manager.getPool('to-change');

    // Reload with changed host
    const updated = { ...cfg, host: 'new-host' };
    await manager.reloadSystems([updated]);

    // Pool for old config should have been closed
    expect(mockPoolClose).toHaveBeenCalled();

    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // closePool
  // -------------------------------------------------------------------------

  it('closePool closes and removes a specific pool', async () => {
    const cfg = makeConfig({ id: 'close-test' });
    const manager = new PoolManager([cfg]);

    await manager.getPool('close-test');
    await manager.closePool('close-test');

    expect(mockPoolClose).toHaveBeenCalled();

    await manager.closeAll();
  });

  it('closePool is a no-op when pool does not exist', async () => {
    const manager = new PoolManager([]);
    // Should not throw
    await expect(manager.closePool('nonexistent')).resolves.toBeUndefined();
    await manager.closeAll();
  });

  // -------------------------------------------------------------------------
  // closeAll
  // -------------------------------------------------------------------------

  it('closeAll closes all pools', async () => {
    const cfgs = [makeConfig({ id: 'ca-1' }), makeConfig({ id: 'ca-2', name: 'Second' })];
    const manager = new PoolManager(cfgs);

    await manager.getPool('ca-1');
    await manager.getPool('ca-2');

    await manager.closeAll();

    expect(mockPoolClose).toHaveBeenCalledTimes(2);
  });
});
