import type { PoolManager } from '../connections/pool-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';

export interface InspectSchemaParams {
  systemId: string;
  objectName?: string;
  includeColumns?: boolean;
  includeConstraints?: boolean;
}

export async function inspectSchema(
  params: InspectSchemaParams,
  poolManager: PoolManager,
  auditLogger: AuditLogger,
  caller: string,
): Promise<unknown> {
  const pool = await poolManager.getPool(params.systemId);
  const includeColumns = params.includeColumns ?? true;
  const start = Date.now();

  let query: string;

  if (params.objectName) {
    // Specific table/view
    query = `
      SELECT
        t.TABLE_SCHEMA,
        t.TABLE_NAME,
        t.TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES t
      WHERE t.TABLE_NAME = @objectName
      ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME;
    `;

    const tablesResult = await pool.request()
      .input('objectName', params.objectName)
      .query(query);

    let columns: unknown[] = [];
    if (includeColumns) {
      const colQuery = `
        SELECT
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.CHARACTER_MAXIMUM_LENGTH,
          c.NUMERIC_PRECISION,
          c.NUMERIC_SCALE,
          c.IS_NULLABLE,
          c.COLUMN_DEFAULT
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_NAME = @objectName
        ORDER BY c.ORDINAL_POSITION;
      `;
      const colResult = await pool.request()
        .input('objectName', params.objectName)
        .query(colQuery);
      columns = colResult.recordset;
    }

    let constraints: unknown[] = [];
    if (params.includeConstraints) {
      const conQuery = `
        SELECT
          tc.CONSTRAINT_NAME,
          tc.CONSTRAINT_TYPE,
          kcu.COLUMN_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE tc.TABLE_NAME = @objectName
        ORDER BY tc.CONSTRAINT_TYPE, kcu.ORDINAL_POSITION;
      `;
      const conResult = await pool.request()
        .input('objectName', params.objectName)
        .query(conQuery);
      constraints = conResult.recordset;
    }

    const durationMs = Date.now() - start;
    await auditLogger.log({
      systemId: params.systemId,
      query: `inspect_schema: ${params.objectName}`,
      toolName: 'inspect_schema',
      caller,
      durationMs,
    });

    return {
      tables: tablesResult.recordset,
      columns,
      constraints,
      durationMs,
    };
  }

  // List all tables
  query = `
    SELECT
      t.TABLE_SCHEMA,
      t.TABLE_NAME,
      t.TABLE_TYPE
    FROM INFORMATION_SCHEMA.TABLES t
    ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME;
  `;

  const result = await pool.request().query(query);
  const durationMs = Date.now() - start;

  await auditLogger.log({
    systemId: params.systemId,
    query: 'inspect_schema: all tables',
    toolName: 'inspect_schema',
    caller,
    durationMs,
    rowCount: result.recordset.length,
  });

  return {
    tables: result.recordset,
    durationMs,
  };
}
