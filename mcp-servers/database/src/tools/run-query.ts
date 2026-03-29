import type { PoolManager } from '../connections/pool-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';
import { validateQuery, wrapReadOnly } from '../security/query-validator.js';

export interface RunQueryParams {
  systemId: string;
  query: string;
  maxRows?: number;
}

export interface RunQueryResult {
  columns: Array<{ name: string; type: string }>;
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
}

export async function runQuery(
  params: RunQueryParams,
  poolManager: PoolManager,
  auditLogger: AuditLogger,
  caller: string,
): Promise<RunQueryResult> {
  const maxRows = params.maxRows ?? 1000;

  const validation = validateQuery(params.query);
  if (!validation.valid) {
    throw new Error(`Query validation failed: ${validation.reason}`);
  }

  const pool = await poolManager.getPool(params.systemId);
  const wrappedQuery = wrapReadOnly(params.query);

  const start = Date.now();
  let error: string | undefined;
  let rowCount = 0;

  try {
    const result = await pool.request().query(wrappedQuery);
    const durationMs = Date.now() - start;

    const recordset = result.recordset ?? [];
    rowCount = recordset.length;
    const truncated = recordset.length > maxRows;
    const rows = truncated ? recordset.slice(0, maxRows) : recordset;

    const columns = result.recordset?.columns
      ? Object.entries(result.recordset.columns).map(([name, col]) => ({
          name,
          type: String((col as unknown as Record<string, unknown>).type ?? 'unknown'),
        }))
      : [];

    await auditLogger.log({
      systemId: params.systemId,
      query: params.query,
      toolName: 'run_query',
      caller,
      durationMs,
      rowCount,
    });

    return { columns, rows, rowCount, durationMs, truncated };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    await auditLogger.log({
      systemId: params.systemId,
      query: params.query,
      toolName: 'run_query',
      caller,
      durationMs: Date.now() - start,
      error,
    });
    throw err;
  }
}
