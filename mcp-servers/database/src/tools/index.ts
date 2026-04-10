import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PoolManager } from '../connections/pool-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { runQuery } from './run-query.js';
import { inspectSchema } from './inspect-schema.js';
import { listIndexes } from './list-indexes.js';
import { getBlockingTree } from './blocking-tree.js';
import { getWaitStats } from './wait-stats.js';
import { getDatabaseHealth } from './database-health.js';

export function registerAllTools(
  server: McpServer,
  poolManager: PoolManager,
  auditLogger: AuditLogger,
): void {
  const caller = 'mcp:claude-code';

  server.tool(
    'run_query',
    'Execute a read-only SQL query against a client SQL Server. Only SELECT and WITH (CTE) queries are accepted. Stored procedure calls (EXEC/EXECUTE), data modification (INSERT/UPDATE/DELETE), DDL (CREATE/ALTER/DROP/TRUNCATE), permissions (GRANT/REVOKE/DENY), backup/restore, sp_configure, xp_*, OPENROWSET, OPENQUERY, and RECONFIGURE are all blocked by the safety filter and will fail. For diagnostic data typically exposed via stored procs (error log, deadlock graphs, blocking sessions), query the corresponding sys.dm_*/sys.fn_* DMVs, Extended Events session ring buffer, or any project-specific SELECT-able views/iTVFs the client has installed. Results are limited to maxRows (default 1000).',
    {
      systemId: z.string().uuid().describe('The system UUID to query'),
      query: z.string().describe('A read-only SQL SELECT or WITH (CTE) query. EXEC, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, and other non-SELECT statements are blocked. Use DMVs or SELECT-able views instead of stored procedures.'),
      maxRows: z.number().int().min(1).max(10000).optional().describe('Maximum rows to return (default 1000)'),
    },
    async (params) => {
      const result = await runQuery(params, poolManager, auditLogger, caller);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'inspect_schema',
    'Get schema information for a database. Without objectName, lists all tables. With objectName, shows columns, data types, and optionally constraints.',
    {
      systemId: z.string().uuid().describe('The system UUID to inspect'),
      objectName: z.string().optional().describe('Table or view name to inspect (omit to list all)'),
      includeColumns: z.boolean().optional().describe('Include column details (default true)'),
      includeConstraints: z.boolean().optional().describe('Include constraints and keys'),
    },
    async (params) => {
      const result = await inspectSchema(params, poolManager, auditLogger, caller);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'list_indexes',
    'List indexes on a table or across the entire database. Optionally include usage statistics (seeks, scans, lookups).',
    {
      systemId: z.string().uuid().describe('The system UUID'),
      tableName: z.string().optional().describe('Filter to a specific table'),
      includeStats: z.boolean().optional().describe('Include index usage statistics'),
    },
    async (params) => {
      const result = await listIndexes(params, poolManager, auditLogger, caller);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'get_blocking_tree',
    'Show current blocking chains on the SQL Server. Returns blocked/blocking sessions with SQL text, wait info, and login details.',
    {
      systemId: z.string().uuid().describe('The system UUID'),
    },
    async (params) => {
      const result = await getBlockingTree(params, poolManager, auditLogger, caller);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'get_wait_stats',
    'Show SQL Server wait statistics sorted by cumulative wait time. Filters out benign/ignorable waits. Useful for diagnosing performance bottlenecks.',
    {
      systemId: z.string().uuid().describe('The system UUID'),
      topN: z.number().int().min(1).max(100).optional().describe('Number of top waits to return (default 20)'),
    },
    async (params) => {
      const result = await getWaitStats(params, poolManager, auditLogger, caller);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'get_database_health',
    'Comprehensive health check: database sizes, backup status, VLF counts, CPU history, memory pressure, and I/O latency.',
    {
      systemId: z.string().uuid().describe('The system UUID'),
    },
    async (params) => {
      const result = await getDatabaseHealth(params, poolManager, auditLogger, caller);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'list_systems',
    'List all active client database systems available for connection.',
    {},
    async () => {
      const systems = await poolManager.listSystems();
      return { content: [{ type: 'text', text: JSON.stringify(systems, null, 2) }] };
    },
  );
}
