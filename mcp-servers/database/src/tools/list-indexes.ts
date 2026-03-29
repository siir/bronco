import type { PoolManager } from '../connections/pool-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';

export interface ListIndexesParams {
  systemId: string;
  tableName?: string;
  includeStats?: boolean;
}

export async function listIndexes(
  params: ListIndexesParams,
  poolManager: PoolManager,
  auditLogger: AuditLogger,
  caller: string,
): Promise<unknown> {
  const pool = await poolManager.getPool(params.systemId);
  const start = Date.now();

  let query = `
    SELECT
      OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,
      OBJECT_NAME(i.object_id) AS table_name,
      i.name AS index_name,
      i.type_desc AS index_type,
      i.is_unique,
      i.is_primary_key,
      STRING_AGG(
        CASE WHEN ic.is_included_column = 0 THEN c.name END, ', '
      ) WITHIN GROUP (ORDER BY ic.key_ordinal) AS key_columns,
      STRING_AGG(
        CASE WHEN ic.is_included_column = 1 THEN c.name END, ', '
      ) WITHIN GROUP (ORDER BY ic.key_ordinal) AS included_columns
    FROM sys.indexes i
    JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
    JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    WHERE i.name IS NOT NULL
  `;

  if (params.tableName) {
    query += ` AND OBJECT_NAME(i.object_id) = @tableName`;
  }

  query += `
    GROUP BY i.object_id, i.name, i.type_desc, i.is_unique, i.is_primary_key
    ORDER BY OBJECT_SCHEMA_NAME(i.object_id), OBJECT_NAME(i.object_id), i.name;
  `;

  const request = pool.request();
  if (params.tableName) {
    request.input('tableName', params.tableName);
  }

  const result = await request.query(query);
  let indexes = result.recordset;

  if (params.includeStats && indexes.length > 0) {
    const statsQuery = `
      SELECT
        OBJECT_NAME(ius.object_id) AS table_name,
        i.name AS index_name,
        ius.user_seeks,
        ius.user_scans,
        ius.user_lookups,
        ius.user_updates,
        ius.last_user_seek,
        ius.last_user_scan
      FROM sys.dm_db_index_usage_stats ius
      JOIN sys.indexes i ON ius.object_id = i.object_id AND ius.index_id = i.index_id
      WHERE ius.database_id = DB_ID()
        AND i.name IS NOT NULL
      ${params.tableName ? 'AND OBJECT_NAME(ius.object_id) = @tableName' : ''}
      ORDER BY OBJECT_NAME(ius.object_id), i.name;
    `;

    const statsRequest = pool.request();
    if (params.tableName) {
      statsRequest.input('tableName', params.tableName);
    }
    const statsResult = await statsRequest.query(statsQuery);

    const statsMap = new Map<string, Record<string, unknown>>();
    for (const row of statsResult.recordset) {
      statsMap.set(`${row.table_name}.${row.index_name}`, row);
    }

    indexes = indexes.map((idx: Record<string, unknown>) => ({
      ...idx,
      usage: statsMap.get(`${idx.table_name}.${idx.index_name}`) ?? null,
    })) as typeof indexes;
  }

  const durationMs = Date.now() - start;
  await auditLogger.log({
    systemId: params.systemId,
    query: `list_indexes: ${params.tableName ?? 'all'}`,
    toolName: 'list_indexes',
    caller,
    durationMs,
    rowCount: indexes.length,
  });

  return { indexes, durationMs };
}
