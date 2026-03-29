import type { PoolManager } from '../connections/pool-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';

export interface DatabaseHealthParams {
  systemId: string;
}

export async function getDatabaseHealth(
  params: DatabaseHealthParams,
  poolManager: PoolManager,
  auditLogger: AuditLogger,
  caller: string,
): Promise<unknown> {
  const pool = await poolManager.getPool(params.systemId);
  const start = Date.now();
  const results: Record<string, unknown> = {};

  // Database sizes
  const sizeResult = await pool.request().query(`
    SELECT
      DB_NAME(database_id) AS database_name,
      type_desc,
      SUM(size * 8.0 / 1024) AS size_mb
    FROM sys.master_files
    GROUP BY database_id, type_desc
    ORDER BY database_name;
  `);
  results.databaseSizes = sizeResult.recordset;

  // Backup status
  const backupResult = await pool.request().query(`
    SELECT
      d.name AS database_name,
      d.recovery_model_desc,
      MAX(CASE WHEN b.type = 'D' THEN b.backup_finish_date END) AS last_full_backup,
      MAX(CASE WHEN b.type = 'L' THEN b.backup_finish_date END) AS last_log_backup,
      DATEDIFF(HOUR, MAX(CASE WHEN b.type = 'D' THEN b.backup_finish_date END), GETDATE()) AS hours_since_full_backup
    FROM sys.databases d
    LEFT JOIN msdb.dbo.backupset b ON d.name = b.database_name
    WHERE d.database_id > 4
    GROUP BY d.name, d.recovery_model_desc
    ORDER BY d.name;
  `);
  results.backupStatus = backupResult.recordset;

  // VLF counts (high VLF count = performance issue)
  const vlfResult = await pool.request().query(`
    SELECT
      DB_NAME(database_id) AS database_name,
      COUNT(*) AS vlf_count
    FROM sys.dm_db_log_info(DB_ID())
    GROUP BY database_id;
  `);
  results.vlfCounts = vlfResult.recordset;

  // CPU pressure
  const cpuResult = await pool.request().query(`
    SELECT
      record_id,
      SQLProcessUtilization AS sql_cpu_pct,
      100 - SystemIdle - SQLProcessUtilization AS other_cpu_pct,
      SystemIdle AS idle_pct,
      EventTime
    FROM (
      SELECT
        record.value('(./Record/@id)[1]', 'int') AS record_id,
        record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]', 'int') AS SystemIdle,
        record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]', 'int') AS SQLProcessUtilization,
        timestamp AS EventTime
      FROM (
        SELECT timestamp, CONVERT(xml, record) AS record
        FROM sys.dm_os_ring_buffers
        WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
          AND record LIKE '%<SystemHealth>%'
      ) AS x
    ) AS y
    ORDER BY record_id DESC
    OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY;
  `);
  results.cpuHistory = cpuResult.recordset;

  // Memory pressure
  const memResult = await pool.request().query(`
    SELECT
      total_physical_memory_kb / 1024 AS total_memory_mb,
      available_physical_memory_kb / 1024 AS available_memory_mb,
      system_memory_state_desc
    FROM sys.dm_os_sys_memory;
  `);
  results.memoryStatus = memResult.recordset;

  // Pending I/O
  const ioResult = await pool.request().query(`
    SELECT
      DB_NAME(vfs.database_id) AS database_name,
      mf.physical_name,
      vfs.io_stall_read_ms,
      vfs.io_stall_write_ms,
      vfs.num_of_reads,
      vfs.num_of_writes,
      CASE WHEN vfs.num_of_reads > 0
        THEN vfs.io_stall_read_ms / vfs.num_of_reads
        ELSE 0
      END AS avg_read_latency_ms,
      CASE WHEN vfs.num_of_writes > 0
        THEN vfs.io_stall_write_ms / vfs.num_of_writes
        ELSE 0
      END AS avg_write_latency_ms
    FROM sys.dm_io_virtual_file_stats(NULL, NULL) vfs
    JOIN sys.master_files mf ON vfs.database_id = mf.database_id AND vfs.file_id = mf.file_id
    ORDER BY (vfs.io_stall_read_ms + vfs.io_stall_write_ms) DESC;
  `);
  results.ioStats = ioResult.recordset;

  const durationMs = Date.now() - start;

  await auditLogger.log({
    systemId: params.systemId,
    query: 'get_database_health',
    toolName: 'get_database_health',
    caller,
    durationMs,
  });

  return { ...results, durationMs };
}
