import mssql from 'mssql';
import type { SystemConnectionConfig } from '@bronco/shared-types';
import { createLogger } from '@bronco/shared-utils';
import type { SystemConfigEntry } from '../config.js';

const logger = createLogger('pool-manager');

interface PoolEntry {
  pool: mssql.ConnectionPool;
  lastUsed: number;
  systemId: string;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class PoolManager {
  private pools = new Map<string, PoolEntry>();
  private configs = new Map<string, SystemConfigEntry>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(systems: SystemConfigEntry[]) {
    for (const system of systems) {
      this.configs.set(system.id, system);
    }
    this.cleanupInterval = setInterval(() => this.cleanupIdlePools(), 60_000);
  }

  async getPool(systemId: string): Promise<mssql.ConnectionPool> {
    const existing = this.pools.get(systemId);
    if (existing) {
      existing.lastUsed = Date.now();
      if (existing.pool.connected) {
        return existing.pool;
      }
      // Pool disconnected, recreate
      this.pools.delete(systemId);
    }
    return this.createPool(systemId);
  }

  getSystemConfig(systemId: string): SystemConnectionConfig {
    const system = this.configs.get(systemId);
    if (!system) {
      throw new Error(`System not found: ${systemId}`);
    }

    return {
      id: system.id,
      clientId: system.clientId,
      name: system.name,
      dbEngine: system.dbEngine,
      host: system.host,
      port: system.port,
      connectionString: system.connectionString ?? null,
      instanceName: system.instanceName ?? null,
      defaultDatabase: system.defaultDatabase ?? null,
      authMethod: system.authMethod,
      username: system.username ?? null,
      password: system.password ?? null,
      useTls: system.useTls,
      trustServerCert: system.trustServerCert,
      connectionTimeout: system.connectionTimeout,
      requestTimeout: system.requestTimeout,
      maxPoolSize: system.maxPoolSize,
      environment: system.environment,
    };
  }

  listSystems(): Array<{
    id: string;
    name: string;
    clientId: string;
    clientName: string;
    clientCode: string;
    dbEngine: string;
    environment: string;
    host: string;
    usesConnectionString: boolean;
  }> {
    return Array.from(this.configs.values()).map((s) => ({
      id: s.id,
      name: s.name,
      clientId: s.clientId,
      clientName: s.clientName,
      clientCode: s.clientCode,
      dbEngine: s.dbEngine,
      environment: s.environment,
      host: s.host,
      usesConnectionString: !!s.connectionString,
    }));
  }

  private async createPool(systemId: string): Promise<mssql.ConnectionPool> {
    const config = this.getSystemConfig(systemId);

    const mssqlConfig = this.buildMssqlConfig(config);

    const pool = new mssql.ConnectionPool(mssqlConfig);

    pool.on('error', (err) => {
      logger.error({ systemId, err: err.message }, 'Pool error');
    });

    await pool.connect();

    logger.info({ systemId, name: config.name, dbEngine: config.dbEngine }, 'Pool created');

    this.pools.set(systemId, {
      pool,
      lastUsed: Date.now(),
      systemId,
    });

    return pool;
  }

  /**
   * Build mssql connection config based on the system's dbEngine type.
   *
   * ─────────────────────────────────────────────────────────────────────
   * EXTENSIBILITY GUIDE — Adding New Connection Types
   * ─────────────────────────────────────────────────────────────────────
   *
   * This method currently handles two SQL Server variants via the mssql
   * (tedious) driver:
   *
   *   - MSSQL: Traditional on-prem SQL Server (host + port + instanceName)
   *   - AZURE_SQL_MI: Azure SQL Managed Instance (connectionString or
   *     host + port 3342 for private endpoint)
   *
   * To add a new connection type (e.g., AZURE_SQL_DB for Azure SQL
   * Database singletons, or on-prem with Kerberos auth):
   *
   * 1. Add the new value to DbEngine in:
   *      - packages/shared-types/src/system.ts (const + type)
   *
   * 2. Add a new entry to the systems config JSON file with the new
   *    dbEngine value.
   *
   * 3. Add a new case in the switch statement below, calling a new
   *    private buildXxxConfig() method.
   *
   * 4. If the new engine uses a DIFFERENT driver (not mssql/tedious):
   *
   *    a. Install the driver package in mcp-servers/database/package.json
   *       (e.g., `pg` for PostgreSQL, `mysql2` for MySQL).
   *
   *    b. Abstract the pool type. Currently all tools receive
   *       mssql.ConnectionPool directly. You'll need to:
   *       - Define a common interface: DatabasePool { query, close }
   *       - Update this.pools Map to store DatabasePool
   *       - Update getPool() return type
   *       - Update all tools in src/tools/ to use the abstraction
   *
   *    c. Alternatively, keep engine-specific tool implementations in
   *       subdirectories (src/tools/mssql/, src/tools/postgres/) and
   *       dispatch based on dbEngine in the tool registration.
   *
   * 5. If the new engine needs additional fields, add them to:
   *      - SystemConnectionConfig in shared-types/src/system.ts
   *      - systemConfigEntrySchema in config.ts
   *
   * 6. Test the connection manually before deploying:
   *      - Add a system entry to the config JSON file
   *      - Call list_systems to verify it appears
   *      - Call inspect_schema to verify connectivity
   * ─────────────────────────────────────────────────────────────────────
   */
  private buildMssqlConfig(config: SystemConnectionConfig): mssql.config {
    switch (config.dbEngine) {
      case 'AZURE_SQL_MI':
        return this.buildAzureSqlMiConfig(config);

      case 'MSSQL':
        return this.buildOnPremMssqlConfig(config);

      default:
        // Future engines that still use the mssql driver would need a
        // case added here. Non-mssql engines require the refactoring
        // described in the extensibility guide above.
        throw new Error(
          `Unsupported dbEngine: ${config.dbEngine}. ` +
          `See pool-manager.ts extensibility guide for adding new engine types.`
        );
    }
  }

  /**
   * On-prem SQL Server: traditional host + port + optional instanceName.
   */
  private buildOnPremMssqlConfig(config: SystemConnectionConfig): mssql.config {
    return {
      server: config.host,
      port: config.port,
      database: config.defaultDatabase ?? 'master',
      user: config.username ?? undefined,
      password: config.password ?? undefined,
      options: {
        encrypt: config.useTls,
        trustServerCertificate: config.trustServerCert,
        instanceName: config.instanceName ?? undefined,
      },
      connectionTimeout: config.connectionTimeout,
      requestTimeout: config.requestTimeout,
      pool: {
        max: config.maxPoolSize,
        min: 0,
        idleTimeoutMillis: IDLE_TIMEOUT_MS,
      },
    };
  }

  /**
   * Azure SQL Managed Instance connection config.
   *
   * Supports two connection approaches:
   *
   * 1. Connection string (preferred for MI):
   *    Stored in system.connectionString. The mssql package can parse
   *    ADO.NET-style connection strings directly.
   *
   * 2. Host + port:
   *    MI private endpoint uses port 3342 by default.
   *    MI public endpoint uses port 1433 (same as on-prem).
   *    Host is the MI FQDN: <instance>.<dns-zone>.database.windows.net
   *
   * Auth: SQL credentials (username + password). Azure AD/Entra auth
   * is NOT used here because it is heavily restricted in the current
   * org. The SQL login is created on the MI with db_datareader
   * permissions only.
   */
  private buildAzureSqlMiConfig(config: SystemConnectionConfig): mssql.config {
    if (config.connectionString) {
      // Parse ADO.NET-style connection string
      const parsed = mssql.ConnectionPool.parseConnectionString(config.connectionString);
      return {
        ...parsed,
        // Override pool settings (connection string may not include these)
        pool: {
          max: config.maxPoolSize,
          min: 0,
          idleTimeoutMillis: IDLE_TIMEOUT_MS,
        },
        connectionTimeout: config.connectionTimeout,
        requestTimeout: config.requestTimeout,
      } as mssql.config;
    }

    // Fallback: host + port approach
    return {
      server: config.host,
      port: config.port, // 3342 for private endpoint, 1433 for public
      database: config.defaultDatabase ?? 'master',
      user: config.username ?? undefined,
      password: config.password ?? undefined,
      options: {
        encrypt: true,                // Always required for Azure SQL MI
        trustServerCertificate: false, // Azure certs are trusted
      },
      connectionTimeout: config.connectionTimeout,
      requestTimeout: config.requestTimeout,
      pool: {
        max: config.maxPoolSize,
        min: 0,
        idleTimeoutMillis: IDLE_TIMEOUT_MS,
      },
    };
  }

  private cleanupIdlePools(): void {
    const now = Date.now();
    for (const [id, entry] of this.pools) {
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
        logger.info({ systemId: id }, 'Closing idle pool');
        entry.pool.close().catch(() => {});
        this.pools.delete(id);
      }
    }
  }

  async closePool(systemId: string): Promise<void> {
    const entry = this.pools.get(systemId);
    if (entry) {
      await entry.pool.close();
      this.pools.delete(systemId);
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.cleanupInterval);
    for (const [, entry] of this.pools) {
      await entry.pool.close().catch(() => {});
    }
    this.pools.clear();
  }
}
