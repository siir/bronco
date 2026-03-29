import type { PoolManager } from '../connections/pool-manager.js';
import type { AuditLogger } from '../security/audit-logger.js';

export interface WaitStatsParams {
  systemId: string;
  topN?: number;
}

const IGNORABLE_WAITS = [
  'BROKER_EVENTHANDLER', 'BROKER_RECEIVE_WAITFOR', 'BROKER_TASK_STOP',
  'BROKER_TO_FLUSH', 'BROKER_TRANSMITTER', 'CHECKPOINT_QUEUE',
  'CHKPT', 'CLR_AUTO_EVENT', 'CLR_MANUAL_EVENT', 'CLR_SEMAPHORE',
  'DBMIRROR_DBM_EVENT', 'DBMIRROR_EVENTS_QUEUE', 'DBMIRRORING_CMD',
  'DIRTY_PAGE_POLL', 'DISPATCHER_QUEUE_SEMAPHORE', 'EXECSYNC',
  'FSAGENT', 'FT_IFTS_SCHEDULER_IDLE_WAIT', 'FT_IFTSHC_MUTEX',
  'HADR_CLUSAPI_CALL', 'HADR_FILESTREAM_IOMGR_IOCOMPLETION',
  'HADR_LOGCAPTURE_WAIT', 'HADR_NOTIFICATION_DEQUEUE',
  'HADR_TIMER_TASK', 'HADR_WORK_QUEUE', 'KSOURCE_WAKEUP',
  'LAZYWRITER_SLEEP', 'LOGMGR_QUEUE', 'MEMORY_ALLOCATION_EXT',
  'ONDEMAND_TASK_QUEUE', 'PREEMPTIVE_XE_GETTARGETSTATE',
  'PWAIT_ALL_COMPONENTS_INITIALIZED', 'PWAIT_DIRECTLOGCONSUMER_GETNEXT',
  'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP', 'QDS_ASYNC_QUEUE',
  'QDS_CLEANUP_STALE_QUERIES_TASK_MAIN_LOOP_SLEEP',
  'REQUEST_FOR_DEADLOCK_SEARCH', 'RESOURCE_QUEUE',
  'SERVER_IDLE_CHECK', 'SLEEP_BPOOL_FLUSH', 'SLEEP_DBSTARTUP',
  'SLEEP_DCOMSTARTUP', 'SLEEP_MASTERDBREADY', 'SLEEP_MASTERMDREADY',
  'SLEEP_MASTERUPGRADED', 'SLEEP_MSDBSTARTUP', 'SLEEP_SYSTEMTASK',
  'SLEEP_TASK', 'SLEEP_TEMPDBSTARTUP', 'SNI_HTTP_ACCEPT',
  'SOS_WORK_DISPATCHER', 'SP_SERVER_DIAGNOSTICS_SLEEP',
  'SQLTRACE_BUFFER_FLUSH', 'SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
  'SQLTRACE_WAIT_ENTRIES', 'WAIT_FOR_RESULTS', 'WAITFOR',
  'WAITFOR_TASKSHUTDOWN', 'WAIT_XTP_CKPT_CLOSE',
  'WAIT_XTP_HOST_WAIT', 'WAIT_XTP_OFFLINE_CKPT_NEW_LOG',
  'WAIT_XTP_RECOVERY', 'XE_BUFFERMGR_ALLPROCESSED_EVENT',
  'XE_DISPATCHER_JOIN', 'XE_DISPATCHER_WAIT', 'XE_LIVE_TARGET_TVF',
  'XE_TIMER_EVENT',
];

export async function getWaitStats(
  params: WaitStatsParams,
  poolManager: PoolManager,
  auditLogger: AuditLogger,
  caller: string,
): Promise<unknown> {
  const pool = await poolManager.getPool(params.systemId);
  const topN = params.topN ?? 20;
  const start = Date.now();

  const ignoreList = IGNORABLE_WAITS.map((w) => `'${w}'`).join(',');

  const query = `
    SELECT TOP (@topN)
      wait_type,
      waiting_tasks_count,
      wait_time_ms / 1000.0 AS wait_time_seconds,
      max_wait_time_ms / 1000.0 AS max_wait_time_seconds,
      signal_wait_time_ms / 1000.0 AS signal_wait_time_seconds,
      (wait_time_ms - signal_wait_time_ms) / 1000.0 AS resource_wait_time_seconds,
      CAST(100.0 * wait_time_ms / SUM(wait_time_ms) OVER () AS DECIMAL(5,2)) AS pct_total
    FROM sys.dm_os_wait_stats
    WHERE wait_type NOT IN (${ignoreList})
      AND waiting_tasks_count > 0
    ORDER BY wait_time_ms DESC;
  `;

  const result = await pool.request()
    .input('topN', topN)
    .query(query);

  const durationMs = Date.now() - start;

  await auditLogger.log({
    systemId: params.systemId,
    query: `get_wait_stats: top ${topN}`,
    toolName: 'get_wait_stats',
    caller,
    durationMs,
    rowCount: result.recordset.length,
  });

  return {
    waitStats: result.recordset,
    durationMs,
  };
}
