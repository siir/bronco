import type { PoolManager } from '../connections/pool-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';

export interface BlockingTreeParams {
  systemId: string;
}

export async function getBlockingTree(
  params: BlockingTreeParams,
  poolManager: PoolManager,
  auditLogger: AuditLogger,
  caller: string,
): Promise<unknown> {
  const pool = await poolManager.getPool(params.systemId);
  const start = Date.now();

  const query = `
    SELECT
      r.session_id AS blocked_spid,
      r.blocking_session_id AS blocking_spid,
      r.wait_type,
      r.wait_time / 1000.0 AS wait_time_seconds,
      r.wait_resource,
      DB_NAME(r.database_id) AS database_name,
      r.status,
      r.command,
      blocked_text.text AS blocked_sql,
      blocker_text.text AS blocker_sql,
      s.login_name AS blocked_login,
      bs.login_name AS blocker_login,
      s.host_name AS blocked_host,
      bs.host_name AS blocker_host,
      r.cpu_time AS blocked_cpu,
      r.reads AS blocked_reads,
      r.writes AS blocked_writes
    FROM sys.dm_exec_requests r
    JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
    LEFT JOIN sys.dm_exec_sessions bs ON r.blocking_session_id = bs.session_id
    CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) AS blocked_text
    OUTER APPLY (
      SELECT TOP 1 req.sql_handle
      FROM sys.dm_exec_requests req
      WHERE req.session_id = r.blocking_session_id
    ) AS blocker_req
    OUTER APPLY sys.dm_exec_sql_text(blocker_req.sql_handle) AS blocker_text
    WHERE r.blocking_session_id > 0
    ORDER BY r.wait_time DESC;
  `;

  const result = await pool.request().query(query);
  const durationMs = Date.now() - start;

  await auditLogger.log({
    systemId: params.systemId,
    query: 'get_blocking_tree',
    toolName: 'get_blocking_tree',
    caller,
    durationMs,
    rowCount: result.recordset.length,
  });

  return {
    blockingChains: result.recordset,
    totalBlocked: result.recordset.length,
    durationMs,
  };
}
