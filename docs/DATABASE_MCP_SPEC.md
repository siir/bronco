<!-- MCP_SPEC_META
version: 2026-03-19T23:25:48Z
source_commit: c45c8991a82ea199ad0eff41415e55409eefcdb4
generator: ai
proc_count: 100
table_count: 48
func_count: 9
view_count: 7
job_count: 5
trigger_count: 1
-->
# SQL-DBAdmin MCP Server Specification

> **Curated specification for the [SQL-DBAdmin](https://github.com/siir/SQL-DBAdmin) repository, with automated refresh via CI.**
> Use this document to build an MCP (Model Context Protocol) server that exposes this SQL Server DBA toolkit's capabilities as tools.

## Overview

SQL Server Database Administration toolkit deployed to an administrative database on SQL Server 2016+ or Azure Managed Instance. All objects are T-SQL — there is no application code. The toolkit provides real-time monitoring (deadlocks, slow queries, blocking, user statements), automated index maintenance with hierarchical configuration, job runtime anomaly detection, database health checks, schema change tracking, and DevOps environment automation.

## Target Environment

- **SQL Server**: 2016+ or Azure Managed Instance
- **Database**: Administrative/utility database (e.g., `DBAdmin`)
- **Authentication**: SQL Server or Windows Authentication
- **Connection**: The MCP server needs a connection string to the admin database

---

## Schemas

| Schema | Modifiable | Purpose |
|--------|-----------|---------|
| `cdre` | Yes | Custom Database Reliability Engineering — primary custom functionality |
| `dbo` | Yes | Utility/wrapper procedures, alert management, monitoring helpers |
| `dev` | Yes | Development helpers (schema change logging, CRUD generators, scripting) |
| `devops` | Yes | DevOps automation (environment deployment/cleanup) |
| `jobs` | Yes | Job management utilities |
| `BrentOzar` | **No** | Third-party First Responder Kit — configure via tables only |
| `Minion` | **No** | Third-party Minion Enterprise framework — configure via tables only |

---

## MCP Tools to Expose

### Deadlock Monitoring

#### `deadlock_monitor_deploy`
- **Procedure**: `cdre.DeadlocksMonitorDeploy`
- **Parameters**: None
- **Description**: Create and start the `DeadlockMonitor` Extended Event session (captures `sqlserver.xml_deadlock_report` to a ring buffer). Initializes the `cdre.DeadLocksLogStatus` row if not present. Part of the three-stage XE monitoring pattern: Deploy → PullFromRingBuffer → Analysis.

#### `deadlock_monitor_destroy`
- **Procedure**: `cdre.DeadlocksMonitorDestroy`
- **Parameters**: None
- **Description**: Stop and drop the `DeadlockMonitor` Extended Event session. Does not delete historical data in `cdre.DeadlocksLogDetails`.

#### `deadlock_restart`
- **Procedure**: `cdre.DeadlocksRestart`
- **Parameters**: None
- **Description**: Restart the deadlock monitoring session (clears ring buffer). Updates `LastRestart` timestamp in `cdre.DeadLocksLogStatus`.

#### `deadlock_pull`
- **Procedure**: `cdre.DeadlocksPullFromRingBuffer`
- **Parameters**: None
- **Description**: Extract deadlock events from the ring buffer, parse XML deadlock graphs, and persist to `cdre.DeadlocksLogDetails`. Idempotent — deduplicates on `(DeadlockTime, SessionId)`. Auto-restarts session based on `MinutesBetweenRestart` from `cdre.DeadLocksLogStatus`. Updates `LastPull` and `LastDeadLock` timestamps. Schedule every 5–15 minutes via SQL Agent.

#### `deadlock_status`
- **Procedure**: `cdre.DeadlocksStatus`
- **Parameters**: None
- **Returns**: Two result sets — (1) monitoring status from `cdre.DeadLocksLogStatus` (or CST timezone view), (2) recent deadlock details from `cdre.DeadlocksLogDetails`.

#### `deadlock_events`
- **Procedure**: `cdre.DeadlocksEvents`
- **Parameters**:
  - `@StartTime DATETIMEOFFSET = NULL` — Start of time window (NULL = use @Hours)
  - `@EndTime DATETIMEOFFSET = NULL` — End of time window (NULL = now)
  - `@Hours INT = 24` — Hours to look back when @StartTime is NULL
- **Description**: Return deadlock events from `cdre.DeadlocksLogDetails` within the specified time window. Useful for targeted investigation of a specific incident window.

#### `deadlock_analysis`
- **Procedure**: `cdre.DeadlocksAnalysis`
- **Parameters**:
  - `@DAYS_BACK INT = 7` — Number of days to analyze
- **Returns**: Multiple result sets including daily deadlock incident counts, trend comparison, top wait resources, top applications involved, top victim queries, and top resource pairs that deadlock together.

---

### Blocking Monitoring

#### `blocking_monitor_deploy`
- **Procedure**: `cdre.BlockingMonitorDeploy`
- **Parameters**:
  - `@ThresholdSeconds INT = 15` — Blocked process threshold in seconds (sets server-level `blocked process threshold` configuration)
  - `@MinutesBetweenRestart INT = 480` — Auto-restart interval in minutes
  - `@Debug BIT = 0` — Debug mode
- **Description**: Create and start the `BlockingMonitor` Extended Event session (captures `sqlserver.blocked_process_report` events to a ring buffer). Sets the SQL Server `blocked process threshold` configuration option. Initializes `cdre.BlockingMonitorLogStatus`. Part of the three-stage XE monitoring pattern: Deploy → PullFromRingBuffer → Analysis.

#### `blocking_monitor_destroy`
- **Procedure**: `cdre.BlockingMonitorDestroy`
- **Parameters**:
  - `@ResetThreshold BIT = 0` — Reset `blocked process threshold` back to 0
  - `@Debug BIT = 0` — Debug mode
- **Description**: Stop and drop the `BlockingMonitor` Extended Event session. Optionally resets the server-level blocked process threshold. Does not delete historical data in `cdre.BlockingLogDetails`.

#### `blocking_monitor_restart`
- **Procedure**: `cdre.BlockingMonitorRestart`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
- **Description**: Restart the blocking monitor session (clears ring buffer). Updates `LastRestart` in `cdre.BlockingMonitorLogStatus`.

#### `blocking_monitor_pull`
- **Procedure**: `cdre.BlockingMonitorPullFromRingBuffer`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
- **Description**: Extract blocking events from the ring buffer, parse XML blocked process reports, and persist to `cdre.BlockingLogDetails`. Captures full blocker and blocked session context including SQL text, login, host, application, database, isolation level, and wait resource. Auto-restarts session based on `MinutesBetweenRestart`. Updates `LastPull` and `LastBlockingEvent` timestamps. Schedule every 5 minutes via SQL Agent.

#### `blocking_monitor_status`
- **Procedure**: `cdre.BlockingMonitorStatus`
- **Parameters**: None
- **Returns**: Monitoring status from `cdre.BlockingMonitorLogStatus` including session state, threshold, last pull time, and last blocking event time.

#### `blocking_monitor_analysis`
- **Procedure**: `cdre.BlockingMonitorAnalysis`
- **Parameters**:
  - `@Hours INT = 24` — Hours of history to analyze
  - `@MinDurationMs INT = 0` — Minimum blocking duration in milliseconds to include
  - `@Report VARCHAR(20) = 'summary'` — Report type: `summary`, `topblockers`, `topresources`, or `timeline`
  - `@Debug BIT = 0` — Debug mode
- **Returns**: Report result set based on `@Report` parameter:
  - `summary` — Overall blocking statistics and recent events
  - `topblockers` — Sessions/logins/applications causing the most blocking
  - `topresources` — Most frequently blocked wait resources
  - `timeline` — Blocking events over time

#### `blocking_sessions`
- **Procedure**: `cdre.BlockingSessions`
- **Parameters**: None
- **Description**: Analyze active blocking chains using recursive CTE against live `sys.dm_exec_requests` and `sys.dm_exec_sessions`. Returns head blockers with full chain hierarchy and SQL text. Use for real-time blocking investigation.

---

### Query Monitoring

#### `query_monitor_deploy`
- **Procedure**: `cdre.QueryMonitorDeploy`
- **Parameters**: None
- **Description**: Create and start the `QueryMonitor` Extended Event session (captures `sqlserver.sql_statement_completed` events with duration > 1 second to a ring buffer). Initializes `cdre.QueryMonitorLogStatus`. Part of the three-stage XE monitoring pattern.

#### `query_monitor_destroy`
- **Procedure**: `cdre.QueryMonitorDestroy`
- **Parameters**: None
- **Description**: Stop and drop the `QueryMonitor` session. Preserves historical data in `cdre.QueryMonitorLogDetails`.

#### `query_monitor_restart`
- **Procedure**: `cdre.QueryMonitorRestart`
- **Parameters**: None
- **Description**: Restart the query monitoring session (clears ring buffer). Updates `LastRestart` in `cdre.QueryMonitorLogStatus`.

#### `query_monitor_pull`
- **Procedure**: `cdre.QueryMonitorPullFromRingBuffer`
- **Parameters**: None
- **Description**: Extract query events from ring buffer, apply INCLUDE/EXCLUDE filters from `cdre.QueryMonitorConfig`, persist to `cdre.QueryMonitorLogDetails`. Aggregates execution statistics per query hash. Auto-restarts based on `MinutesBetweenRestart` interval. Updates `LastPull`, `LastQueryCaptured`, and `TotalQueriesTracked`. Schedule every 10–15 minutes via SQL Agent.

#### `query_monitor_status`
- **Procedure**: `cdre.QueryMonitorStatus`
- **Parameters**: None
- **Returns**: Multiple result sets — status info from `cdre.QueryMonitorLogStatus`, XE session state, active config filters from `cdre.QueryMonitorConfig`, and 20 most recent queries.

#### `query_monitor_analysis`
- **Procedure**: `cdre.QueryMonitorAnalysis`
- **Parameters**:
  - `@LoginName NVARCHAR(128) = NULL` — Filter by login (NULL = all)
  - `@DatabaseName NVARCHAR(128) = NULL` — Filter by database (NULL = all)
  - `@DAYS_BACK INT = 7` — Days of history
- **Returns**: Multiple result sets including top queries by execution count, average duration, total duration, logical reads, summary by login, and summary by database.

#### `query_monitor_extract_index_info`
- **Procedure**: `cdre.QueryMonitorExtractIndexInfo`
- **Parameters**:
  - `@QueryId BIGINT = NULL` — Specific query to analyze (NULL = all)
  - `@LoginName NVARCHAR(128) = NULL` — Filter by login
  - `@DatabaseName NVARCHAR(128) = NULL` — Filter by database
- **Description**: Parse XML execution plans to identify indexes used and their fragmentation levels. Updates `IndexesUsed` and `IndexFragmentation` fields in `cdre.QueryMonitorLogDetails`.

#### `query_monitor_concurrent_activity`
- **Procedure**: `cdre.QueryMonitorConcurrentActivity`
- **Parameters**:
  - `@StartTime DATETIME2` — Start of window to analyze (required)
  - `@EndTime DATETIME2` — End of window to analyze (required)
  - `@DatabaseName NVARCHAR(128) = NULL` — Filter by database (NULL = all)
- **Description**: Analyze concurrent query activity from `cdre.QueryMonitorLogDetails` to identify overlapping execution windows within a specific time range. Useful for understanding resource contention patterns during an incident.

---

### User Statement Capture

#### `user_statements_deploy`
- **Procedure**: `cdre.CapturedUserStatementsDeploy`
- **Parameters**: None
- **Description**: Create and start `Capture_UserStatements_RB` Extended Event session (captures `sqlserver.sql_statement_completed` with ring buffer target, `TRACK_CAUSALITY=ON`). Filters out IDE/tool noise (Red Gate SQL Prompt, SSMS IntelliSense, Entity Framework). Initializes `cdre.CapturedUserStatementsStatus`. Part of the three-stage XE monitoring pattern.

#### `user_statements_destroy`
- **Procedure**: `cdre.CaptureUserStatementsDestroy`
- **Parameters**: None
- **Description**: Stop and drop the user statement capture session. Preserves historical data in `cdre.CapturedUserStatements`.

#### `user_statements_restart`
- **Procedure**: `cdre.CaptureUserStatementsRestart`
- **Parameters**: None
- **Description**: Restart the capture session (clears ring buffer). Updates `LastRestart` in `cdre.CapturedUserStatementsStatus`.

#### `user_statements_pull`
- **Procedure**: `cdre.CapturedUserStatementsPullFromBuffer`
- **Parameters**: None
- **Description**: Extract user statements from ring buffer, apply include/exclude filters from `cdre.CapturedUserStatementsConfig`, persist to `cdre.CapturedUserStatements`. Uses `IGNORE_DUP_KEY` on `(EventTimeUtc, SessionId, EventName, SqlHash)` for deduplication. Enforces `RetentionDays` from `cdre.CapturedUserStatementsStatus`.

#### `user_statements_recent`
- **Procedure**: `cdre.CapturedUserStatements_Recent`
- **Parameters**:
  - `@Top INT = 50` — Number of recent statements to return
  - `@LoginName NVARCHAR(128) = NULL` — Filter by login name (NULL = all)
  - `@DatabaseName SYSNAME = NULL` — Filter by database (NULL = all)
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recently captured user statements from `cdre.CapturedUserStatements`, ordered by most recent event time. Useful for real-time visibility into what users are executing.

---

### Index Maintenance

#### `index_maint`
- **Procedure**: `cdre.IndexMaint`
- **Parameters**:
  - `@DATABASES VARCHAR(MAX) = NULL` — Comma-separated database list (NULL = all user databases)
  - `@DEFAULT_REORG_THRESHOLD FLOAT = 5` — Fragmentation % threshold for REORGANIZE
  - `@DEFAULT_FRAGMENTATION_THRESHOLD FLOAT = 15` — Fragmentation % threshold for REBUILD
  - `@DEFAULT_PAGECOUNT_THRESHOLD INT = 100` — Minimum page count to consider for maintenance
  - `@TOTAL_EXECUTION_LIMIT_MINUTES INT = 0` — Overall time limit (0 = unlimited)
  - `@DATABASE_EXECUTION_LIMIT_MINUTES INT = 0` — Per-database time limit (0 = unlimited)
  - `@EXECID UNIQUEIDENTIFIER = NULL OUTPUT` — Unique execution ID for correlation
  - `@LOCK_TIMEOUT_SECONDS INT = 300` — Lock timeout for index operations
  - `@ABORT_AFTER_WAIT VARCHAR(8) = 'SELF'` — Action after lock timeout: `SELF`, `BLOCKERS`, or `NONE`
  - `@DEBUG BIT = 0` — Debug mode with verbose output
- **Description**: Orchestrate index fragmentation analysis and maintenance across databases. Uses hierarchical configuration cascade (Index > Table > Schema > Database > Default). Decides between REORGANIZE and REBUILD based on effective thresholds. Logs to `cdre.IndexMaintHistory`, `cdre.IndexMaintHistoryDatabases`, and `cdre.IndexMaintHistoryDetails`.

#### `index_maint_history`
- **Procedure**: `cdre.IndexMaintIndexHistory`
- **Parameters**:
  - `@Database SYSNAME` — Database name (required)
  - `@Schema SYSNAME = NULL` — Schema filter
  - `@Table SYSNAME = NULL` — Table filter
  - `@Index SYSNAME = NULL` — Index filter
  - `@Last INT = 10` — Number of recent records to return
  - `@Debug BIT = 0` — Debug mode
- **Description**: Query historical index maintenance operations for a specific index or set of indexes. Shows fragmentation trends and maintenance actions over time from `cdre.IndexMaintHistoryDetails`.

#### `index_maint_job_review`
- **Procedure**: `cdre.IndexMaintJobReview`
- **Parameters**:
  - `@JobsAgo INT = 1` — Which execution to review (1 = most recent)
  - `@Debug BIT = 0` — Debug mode
- **Description**: Review index maintenance job execution with summary, database breakdown, and stuck index detection. Useful for post-maintenance validation.

#### `index_maint_config`
- **Procedure**: `cdre.IndexMaint_Config`
- **Parameters**:
  - `@Database SYSNAME = NULL` — Filter to a specific database (NULL = all)
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display the current effective index maintenance configuration, showing the resolved cascade of settings from Server → Database → Schema → Table → Index levels.

---

### Job Runtime Monitoring

#### `job_runtime_baseline_update`
- **Procedure**: `cdre.JobRuntimeBaseline_Update`
- **Parameters**:
  - `@MinHistoricalRuns INT = 5` — Minimum successful runs required for baseline calculation
  - `@LookbackDays INT = 30` — Days of history to analyze
  - `@Debug BIT = 0` — Show detailed debug output
  - `@Help BIT = 0` — Display help information
- **Description**: Calculate and store runtime baselines for all SQL Agent jobs based on historical execution data. Applies outlier detection (IQR, StdDev, or Percentile methods per `cdre.JobRuntimeAnomalyConfig`). Stores median, average, and percentile statistics in `cdre.JobRuntimeBaseline`. Uses MERGE to upsert on `job_id`. Run daily at 1:00 AM via the `DBA - Job Runtime Baseline Update` job.

#### `job_runtime_anomaly_detection`
- **Procedure**: `cdre.JobRuntimeAnomaly_Detection`
- **Parameters**:
  - `@Debug BIT = 0` — Show detailed debug output
  - `@Help BIT = 0` — Display help information
- **Description**: Detect currently running SQL Agent jobs that exceed baseline thresholds. Compares running jobs against baselines stored in `cdre.JobRuntimeBaseline`. Uses `RuntimeThresholdMultiplier` (default 3x), `MinimumRuntimeMinutes`, and `MaximumRuntimeMinutes` from `cdre.JobRuntimeAnomalyConfig`. Prerequisite: run `JobRuntimeBaseline_Update` first. Run every 15 minutes via the `DBA - Job Runtime Anomaly Detection` job.

#### `job_runtime_baselines`
- **Procedure**: `cdre.JobRuntimeBaselines`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return the current stored baseline statistics for all SQL Agent jobs from `cdre.JobRuntimeBaseline`. Shows median, average, percentile runtimes, and calculation metadata.

#### `job_step_history`
- **Procedure**: `cdre.JobStepHistory`
- **Parameters**:
  - `@JobName NVARCHAR(128)` — Job name (required)
  - `@RunDate DATE = NULL` — Filter to a specific run date (NULL = most recent runs)
  - `@Runs INT = 10` — Number of recent runs to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return per-step execution history for a SQL Agent job. Uses `JOBHISTORY_ALL` view if available (Azure Managed Instance), otherwise falls back to `msdb.dbo.sysjobhistory`. Shows step name, status, duration, and message for each step of each run.

#### `job_history`
- **Procedure**: `cdre.Job_History`
- **Parameters**:
  - `@JobName NVARCHAR(128) = NULL` — Filter to a specific job (NULL = all jobs)
  - `@DaysBack INT = 7` — Days of history to return
  - `@FailuresOnly BIT = 0` — Return only failed runs
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return SQL Agent job execution history with status, duration, and outcome details from `msdb`.

#### `job_schedules`
- **Procedure**: `cdre.Job_Schedules`
- **Parameters**:
  - `@JobName NVARCHAR(128) = NULL` — Filter to a specific job (NULL = all jobs)
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return SQL Agent job schedule definitions, showing next run times and frequency settings.

---

### Database Maintenance

#### `maintenance_dbcc_checkdb`
- **Procedure**: `cdre.Maintenance_DBCCCheckDB`
- **Parameters**:
  - `@ExecGUID VARCHAR(36) = NULL OUTPUT` — Execution tracking ID
- **Description**: Run `DBCC CHECKDB` on all online databases (respecting exclusion list in `cdre.SettingsDB` where `ExecName` matches). Logs results to `cdre.MaintenanceResults`.

#### `maintenance_update_stats`
- **Procedure**: `cdre.Maintenance_UpdateAllStats`
- **Parameters**:
  - `@ExecGUID VARCHAR(36) = NULL OUTPUT` — Execution tracking ID
- **Description**: Run `sp_updatestats` on all non-excluded databases. Logs results to `cdre.MaintenanceResults`.

#### `maintenance_find_invalid_objects`
- **Procedure**: `cdre.Maintenance_FindInvalidObjects`
- **Parameters**:
  - `@ExecGUID VARCHAR(36) = NULL OUTPUT` — Execution tracking ID
- **Description**: Find invalid objects (broken references, orphaned dependencies) across databases. Logs to `cdre.InvalidObjects`.

#### `maintenance_results`
- **Procedure**: `cdre.Maintenance_Results`
- **Parameters**:
  - `@Operation VARCHAR(100) = NULL` — Filter by operation type (NULL = all)
  - `@DaysBack INT = 7` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recent maintenance operation results from `cdre.MaintenanceResults`, showing DBCC, stats update, and other maintenance outcomes.

#### `invalid_objects_report`
- **Procedure**: `cdre.InvalidObjects_Report`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report on invalid objects found across databases from `cdre.InvalidObjects`. Groups by database and object type.

#### `log_storage_usage`
- **Procedure**: `cdre.LogStorageUsage`
- **Parameters**:
  - `@EXEC_ID UNIQUEIDENTIFIER = NULL OUTPUT` — Execution tracking ID
- **Description**: Log database and table sizes to `cdre.SizeLogs_Database` and `cdre.SizeLogs_Tables`. Enforces 12-month retention.

#### `storage_usage_database`
- **Procedure**: `cdre.StorageUsage_Database`
- **Parameters**:
  - `@DatabaseName SYSNAME = NULL` — Filter to a specific database (NULL = all)
  - `@DaysBack INT = 30` — Days of history to include
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report current and historical database size trends from `cdre.SizeLogs_Database`. Shows growth over time.

#### `storage_usage_tables`
- **Procedure**: `cdre.StorageUsage_Tables`
- **Parameters**:
  - `@DatabaseName SYSNAME = NULL` — Filter to a specific database (NULL = all)
  - `@TableName SYSNAME = NULL` — Filter to a specific table (NULL = all)
  - `@DaysBack INT = 30` — Days of history to include
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report current and historical table size trends from `cdre.SizeLogs_Tables`. Shows the largest tables and growth patterns.

---

### Server Health & Diagnostics

#### `server_health_overview`
- **Procedure**: `cdre.ServerHealth_Overview`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: High-level server health summary including SQL Server version, memory, CPU, database count, and key configuration settings.

#### `server_health_database_check`
- **Procedure**: `cdre.ServerHealth_DatabaseCheck`
- **Parameters**:
  - `@DatabaseName SYSNAME` — Database to check (required)
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Per-database health check reporting on database state, recovery model, compatibility level, last backup, and suspect pages.

#### `backup_status`
- **Procedure**: `cdre.BackupStatus`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report backup status across all databases, showing last full, differential, and log backup times with age calculations.

#### `msdb_failed_jobs`
- **Procedure**: `cdre.Msdb_FailedJobs`
- **Parameters**:
  - `@DaysBack INT = 1` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recently failed SQL Agent jobs from `msdb`, showing job name, step, error message, and failure time.

#### `msdb_suspect_pages`
- **Procedure**: `cdre.Msdb_SuspectPages`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return suspect pages from `msdb.dbo.suspect_pages`, indicating potential database corruption.

#### `msdb_alert_history`
- **Procedure**: `cdre.Msdb_AlertHistory`
- **Parameters**:
  - `@DaysBack INT = 7` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return SQL Server Agent alert history from `msdb`, showing recent alert firings and counts.

#### `msdb_database_mail_log`
- **Procedure**: `cdre.Msdb_DatabaseMailLog`
- **Parameters**:
  - `@DaysBack INT = 3` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return Database Mail send log from `msdb`, showing recent email delivery status and errors.

#### `msdb_maintenance_plans`
- **Procedure**: `cdre.Msdb_MaintenancePlans`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return SQL Server Maintenance Plan definitions and last execution status from `msdb`.

#### `resolve_wait_resource`
- **Procedure**: `cdre.ResolveWaitResource`
- **Parameters**:
  - `@WaitResource NVARCHAR(256)` — Wait resource string (e.g., `KEY: 5:72057594038321152 (8194443284a0)`, `PAGE: 5:1:12345`, `RID: 5:1:12345:0`)
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Resolve a SQL Server wait resource string to a human-readable object name (database, schema, table, index). Handles KEY, PAGE, RID, and OBJECT lock types. Uses `DBCC PAGE` for page-level resolution. System/IAM/GAM pages return a descriptive error row rather than crashing. For KEY locks, resolves via `sys.dm_tran_locks` `hobt_id`.

#### `data_sync_job_history`
- **Procedure**: `cdre.DataSync_JobHistory`
- **Parameters**:
  - `@DaysBack INT = 3` — Number of days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report on Azure Data Sync job history, showing sync status, errors, and timing for recent sync operations.

#### `data_sync_queue_status`
- **Procedure**: `cdre.DataSync_QueueStatus`
- **Parameters**:
  - `@HoursBack INT = 24` — Hours of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report on Azure Data Sync queue depth and processing status. Shows pending, processing, and completed sync operations within the specified window.

#### `evo_error_log`
- **Procedure**: `cdre.Evo_ErrorLog`
- **Parameters**:
  - `@DaysBack INT = 7` — Days of history to return
  - `@ErrorProcedure NVARCHAR(200) = NULL` — Filter by procedure name
  - `@LoginName NVARCHAR(200) = NULL` — Filter by login name
  - `@Severity INT = NULL` — Filter by error severity
  - `@MessageSearch NVARCHAR(500) = NULL` — Filter by message text substring
  - `@MaxRows INT = 100` — Maximum rows to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Query the Evolution application error log table for recent errors with filtering by procedure, login, severity, and message text.

#### `evo_error_log_summary`
- **Procedure**: `cdre.Evo_ErrorLogSummary`
- **Parameters**:
  - `@DaysBack INT = 7` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Summarize Evolution application errors grouped by procedure and error message, showing frequency and most recent occurrence.

---

### Monitoring Utilities

#### `activity_monitor`
- **Procedure**: `dbo.ActivityMonitor`
- **Parameters**:
  - `@ShowDetails BIT = 0` — Show SQL text for sessions
  - `@HideDbs VARCHAR(MAX) = 'master,msdb,'` — Comma-separated databases to hide
  - `@HideLogins VARCHAR(MAX) = 'sa'` — Comma-separated logins to hide
  - `@ShowLogins VARCHAR(MAX) = ''` — Only show these logins (empty = all)
  - `@ShowDbs VARCHAR(MAX) = ''` — Only show these databases (empty = all)
  - `@BlockingRelevantOnly BIT = 0` — Show only sessions involved in blocking
  - `@CommandSearch VARCHAR(MAX) = ''` — Filter by command text
- **Description**: Parse `sp_who2` output to display active sessions with blocking chain analysis, filtering, and search capabilities.

#### `user_mapping`
- **Procedure**: `cdre.UserMapping`
- **Parameters**: None
- **Description**: Report user-to-database-principal-role-permission mappings across all databases. Useful for security audits.

#### `schema_change_log`
- **Procedure**: `cdre.SchemaChangeLog`
- **Parameters**:
  - `@DaysBack INT = 7` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recent schema change events from `dev.SchemaChangeLog`, showing DDL changes captured by the `dev_trg_LogSchemaChanges` database trigger.

#### `immediate_message`
- **Procedure**: `cdre.Immediate`
- **Parameters**:
  - `@Message NVARCHAR(MAX)` — Message to output
- **Description**: Utility to output a message immediately using `RAISERROR ... WITH NOWAIT`. Used internally by other procedures for progress reporting.

---

### Configuration Management

#### `config_alerts`
- **Procedure**: `cdre.Config_Alerts`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display and manage alert configuration from `dbo.AlertConfig` and `dbo.NotificationTargets`.

#### `config_blitz_skip_checks`
- **Procedure**: `cdre.Config_BlitzSkipChecks`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display current `BrentOzar.Config_Blitz_SkipChecks` entries showing which Blitz health checks are suppressed.

#### `config_deadlock_monitor`
- **Procedure**: `cdre.Config_DeadlockMonitor`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display and manage deadlock monitor configuration from `cdre.DeadLocksLogStatus`.

#### `config_query_monitor`
- **Procedure**: `cdre.Config_QueryMonitor`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display and manage query monitor configuration from `cdre.QueryMonitorConfig` and `cdre.QueryMonitorLogStatus`.

#### `config_settings`
- **Procedure**: `cdre.Config_Settings`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display general DBA toolkit settings from `cdre.SettingsDB` and related configuration tables.

---

### Brent Ozar Integration

#### `blitz_monitor`
- **Procedure**: `dbo.BrentOzar_Blitz_Monitor`
- **Parameters**: None
- **Description**: Run `sp_Blitz` health checks, persist results to `BrentOzar.Results_Blitz`, send HTML email if issues found.

#### `blitz_generate_fixes`
- **Procedure**: `dbo.BrentOzar_Blitz_GenerateCommonFixesScript`
- **Parameters**: None
- **Description**: Generate T-SQL fix scripts for common Blitz findings (missing email operators, non-standard database owners, etc.).

#### `blitzwho_monitor`
- **Procedure**: `dbo.BrentOzar_BlitzWho_Monitor`
- **Parameters**: None
- **Description**: Run `sp_BlitzWho` blocking analysis, send HTML email if blocking detected.

#### `blitzwho_job_monitor`
- **Procedure**: `dbo.BrentOzar_BlitzWho_JobMonitor`
- **Parameters**: None
- **Description**: SQL Agent job session monitoring with extended performance metrics. Uses `dbo.BlitzWho_JobMonitor_Jobs` for job-to-display-name mapping.

#### `blitzwho_results`
- **Procedure**: `BrentOzar.BlitzWho_Results_Rq`
- **Parameters**:
  - `@ExecId UNIQUEIDENTIFIER` — Execution ID to retrieve
- **Description**: Retrieve stored BlitzWho results for a specific execution from `BrentOzar.Results_BlitzWho`.

#### `sp_blitz`
- **Procedure**: `BrentOzar.sp_Blitz`
- **Parameters**:
  - `@Help TINYINT = 0`
  - `@CheckUserDatabaseObjects TINYINT = 1`
  - `@CheckProcedureCache TINYINT = 0`
  - `@OutputType VARCHAR(20) = 'TABLE'`
  - `@OutputProcedureCache TINYINT = 0`
  - `@CheckProcedureCacheFilter VARCHAR(10) = NULL`
  - `@CheckServerInfo TINYINT = 0`
  - `@SkipChecksServer NVARCHAR(256) = NULL`
  - `@SkipChecksDatabase NVARCHAR(256) = NULL`
  - `@SkipChecksSchema NVARCHAR(256) = NULL`
  - `@SkipChecksTable NVARCHAR(256) = NULL`
  - `@IgnorePrioritiesBelow INT = NULL`
  - `@IgnorePrioritiesAbove INT = NULL`
  - `@OutputServerName NVARCHAR(256) = NULL`
  - `@OutputDatabaseName NVARCHAR(256) = NULL`
  - `@OutputSchemaName NVARCHAR(256) = NULL`
  - `@OutputTableName NVARCHAR(256) = NULL`
  - `@OutputXMLasNVARCHAR TINYINT = 0`
  - `@EmailRecipients VARCHAR(MAX) = NULL`
  - `@EmailProfile SYSNAME = NULL`
  - `@SummaryMode TINYINT = 0`
  - `@BringThePain TINYINT = 0`
  - `@UsualDBOwner SYSNAME = NULL`
  - `@Debug TINYINT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Third-party First Responder Kit health check. Customized with skip checks for standard service accounts and accepted configuration values. **Do not modify source.** Configure via `BrentOzar.Config_Blitz_SkipChecks`.

#### `sp_blitz_backups`
- **Procedure**: `BrentOzar.sp_BlitzBackups`
- **Parameters**:
  - `@Help TINYINT = 0`
  - `@HoursBack INT = 168`
  - `@MSDBName NVARCHAR(256) = 'msdb'`
  - `@AGName NVARCHAR(256) = NULL`
  - `@RestoreSpeedFullMBps INT = NULL`
  - `@RestoreSpeedDiffMBps INT = NULL`
  - `@RestoreSpeedLogMBps INT = NULL`
  - `@Debug TINYINT = 0`
  - `@PushBackupHistoryToListener BIT = 0`
  - `@WriteBackupsToListenerName NVARCHAR(256) = NULL`
  - `@WriteBackupsToDatabaseName NVARCHAR(256) = NULL`
  - `@WriteBackupsLastHours INT = 168`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Analyze backup history and estimate restore times. **Do not modify source.**

#### `sp_blitz_cache`
- **Procedure**: `BrentOzar.sp_BlitzCache`
- **Parameters**:
  - `@Help BIT = 0`
  - `@Top INT = NULL`
  - `@SortOrder VARCHAR(50) = 'CPU'`
  - `@UseTriggersAnyway BIT = NULL`
  - `@ExportToExcel BIT = 0`
  - `@ExpertMode TINYINT = 0`
  - `@OutputServerName NVARCHAR(258) = NULL`
  - `@OutputDatabaseName NVARCHAR(258) = NULL`
  - `@OutputSchemaName NVARCHAR(258) = NULL`
  - `@OutputTableName NVARCHAR(258) = NULL`
  - `@ConfigurationDatabaseName NVARCHAR(128) = NULL`
  - `@ConfigurationSchemaName NVARCHAR(258) = NULL`
  - `@ConfigurationTableName NVARCHAR(258) = NULL`
  - `@DurationFilter DECIMAL(38,4) = NULL`
  - `@HideSummary BIT = 0`
  - `@IgnoreSystemDBs BIT = 1`
  - `@OnlyQueryHashes VARCHAR(MAX) = NULL`
  - `@IgnoreQueryHashes VARCHAR(MAX) = NULL`
  - `@OnlySqlHandles VARCHAR(MAX) = NULL`
  - `@IgnoreSqlHandles VARCHAR(MAX) = NULL`
  - `@QueryFilter VARCHAR(10) = 'ALL'`
  - `@DatabaseName NVARCHAR(128) = NULL`
  - `@StoredProcName NVARCHAR(128) = NULL`
  - `@SlowlySearchPlansFor NVARCHAR(4000) = NULL`
  - `@Reanalyze BIT = 0`
  - `@SkipAnalysis BIT = 0`
  - `@BringThePain BIT = 0`
  - `@MinimumExecutionCount INT = 0`
  - `@Debug BIT = 0`
  - `@CheckDateOverride DATETIMEOFFSET = NULL`
  - `@MinutesBack INT = NULL`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Analyze plan cache for resource-intensive queries. Sort by CPU, reads, duration, executions, etc. **Do not modify source.**

#### `sp_blitz_first`
- **Procedure**: `BrentOzar.sp_BlitzFirst`
- **Parameters**:
  - `@LogMessage NVARCHAR(4000) = NULL`
  - `@Help TINYINT = 0`
  - `@AsOf DATETIMEOFFSET = NULL`
  - `@ExpertMode TINYINT = 0`
  - `@Seconds INT = 5`
  - `@OutputType VARCHAR(20) = 'TABLE'`
  - `@OutputServerName NVARCHAR(256) = NULL`
  - `@OutputDatabaseName NVARCHAR(256) = NULL`
  - `@OutputSchemaName NVARCHAR(256) = NULL`
  - `@OutputTableName NVARCHAR(256) = NULL`
  - `@OutputTableNameFileStats NVARCHAR(256) = NULL`
  - `@OutputTableNamePerfmonStats NVARCHAR(256) = NULL`
  - `@OutputTableNameWaitStats NVARCHAR(256) = NULL`
  - `@OutputTableNameBlitzCache NVARCHAR(256) = NULL`
  - `@OutputTableRetentionDays TINYINT = 7`
  - `@OutputXMLasNVARCHAR TINYINT = 0`
  - `@FilterPlansByDatabase VARCHAR(MAX) = NULL`
  - `@CheckProcedureCache TINYINT = 0`
  - `@CheckServerInfo TINYINT = 1`
  - `@FileLatencyThresholdMS INT = 100`
  - `@SinceStartup TINYINT = 0`
  - `@ShowSleepingSPIDs TINYINT = 0`
  - `@LogMessageCheckID INT = 38`
  - `@LogMessagePriority TINYINT = 1`
  - `@LogMessageFindingsGroup VARCHAR(50) = 'Logged Message'`
  - `@LogMessageFinding VARCHAR(200) = 'Logged from sp_BlitzFirst'`
  - `@LogMessageURL VARCHAR(200) = ''`
  - `@LogMessageCheckDate DATETIMEOFFSET = NULL`
  - `@Debug BIT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Real-time server performance snapshot — waits, file stats, perfmon counters over a sample period. **Do not modify source.**

#### `sp_blitz_index`
- **Procedure**: `BrentOzar.sp_BlitzIndex`
- **Parameters**:
  - `@DatabaseName NVARCHAR(128) = NULL`
  - `@SchemaName NVARCHAR(128) = NULL`
  - `@TableName NVARCHAR(128) = NULL`
  - `@Mode TINYINT = 0` — 0=Diagnose, 1=Summarize, 2=Usage Detail, 3=Missing Index, 4=Diagnose Details
  - `@Filter TINYINT = 0` — 0=No filter, 1=No low-usage warnings for 0-read objects, 2=Only ≥500MB
  - `@SkipPartitions BIT = 0`
  - `@SkipStatistics BIT = 1`
  - `@GetAllDatabases BIT = 0`
  - `@BringThePain BIT = 0`
  - `@IgnoreDatabases NVARCHAR(MAX) = NULL`
  - `@ThresholdMB INT = 250`
  - `@OutputType VARCHAR(20) = 'TABLE'`
  - `@OutputServerName NVARCHAR(256) = NULL`
  - `@OutputDatabaseName NVARCHAR(256) = NULL`
  - `@OutputSchemaName NVARCHAR(256) = NULL`
  - `@OutputTableName NVARCHAR(256) = NULL`
  - `@Help TINYINT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Index analysis — missing indexes, unused indexes, duplicate indexes, sizing. **Do not modify source.**

#### `sp_blitz_lock`
- **Procedure**: `BrentOzar.sp_BlitzLock`
- **Parameters**:
  - `@Top INT = 2147483647`
  - `@DatabaseName NVARCHAR(256) = NULL`
  - `@StartDate DATETIME = '19000101'`
  - `@EndDate DATETIME = '99991231'`
  - `@ObjectName NVARCHAR(1000) = NULL`
  - `@StoredProcName NVARCHAR(1000) = NULL`
  - `@AppName NVARCHAR(256) = NULL`
  - `@HostName NVARCHAR(256) = NULL`
  - `@LoginName NVARCHAR(256) = NULL`
  - `@EventSessionPath VARCHAR(256) = 'system_health*.xel'`
  - `@Debug BIT = 0`
  - `@Help BIT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Analyze deadlocks from system_health or custom XE session files. **Do not modify source.**

#### `sp_blitz_query_store`
- **Procedure**: `BrentOzar.sp_BlitzQueryStore`
- **Parameters**:
  - `@Help BIT = 0`
  - `@DatabaseName NVARCHAR(128) = NULL`
  - `@Top INT = 3`
  - `@StartDate DATETIME2 = NULL`
  - `@EndDate DATETIME2 = NULL`
  - `@MinimumExecutionCount INT = NULL`
  - `@DurationFilter DECIMAL(38,4) = NULL`
  - `@StoredProcName NVARCHAR(128) = NULL`
  - `@Failed BIT = 0`
  - `@PlanIdFilter INT = NULL`
  - `@QueryIdFilter INT = NULL`
  - `@ExportToExcel BIT = 0`
  - `@HideSummary BIT = 0`
  - `@SkipXML BIT = 0`
  - `@Debug BIT = 0`
  - `@ExpertMode BIT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Analyze Query Store data for plan regressions and performance issues. **Do not modify source.**

#### `sp_blitz_who`
- **Procedure**: `BrentOzar.sp_BlitzWho`
- **Parameters**:
  - `@Help TINYINT = 0`
  - `@ShowSleepingSPIDs TINYINT = 0`
  - `@ExpertMode BIT = 0`
  - `@Debug BIT = 0`
  - `@OutputDatabaseName NVARCHAR(256) = NULL`
  - `@OutputSchemaName NVARCHAR(256) = NULL`
  - `@OutputTableName NVARCHAR(256) = NULL`
  - `@OutputTableRetentionDays TINYINT = 3`
  - `@MinElapsedSeconds INT = 0`
  - `@MinCPUTime INT = 0`
  - `@MinLogicalReads INT = 0`
  - `@MinPhysicalReads INT = 0`
  - `@MinWrites INT = 0`
  - `@MinTempdbMB INT = 0`
  - `@MinRequestedMemoryKB INT = 0`
  - `@MinBlockingSeconds INT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Real-time session monitoring with resource consumption details. **Do not modify source.**

#### `sp_foreachdb`
- **Procedure**: `BrentOzar.sp_foreachdb`
- **Parameters**:
  - `@command1 NVARCHAR(MAX) = NULL`
  - `@replacechar NCHAR(1) = N'?'`
  - `@command2 NVARCHAR(MAX) = NULL`
  - `@command3 NVARCHAR(MAX) = NULL`
  - `@precommand NVARCHAR(MAX) = NULL`
  - `@postcommand NVARCHAR(MAX) = NULL`
  - `@command NVARCHAR(MAX) = NULL` — Backwards compatibility alias
  - `@print_dbname BIT = 0`
  - `@print_command_only BIT = 0`
  - `@suppress_quotename BIT = 0`
  - `@system_only BIT = NULL`
  - `@user_only BIT = NULL`
  - `@name_pattern NVARCHAR(300) = N'%'`
  - `@database_list NVARCHAR(MAX) = NULL`
  - `@exclude_list NVARCHAR(MAX) = NULL`
  - `@recovery_model_desc NVARCHAR(120) = NULL`
  - `@compatibility_level TINYINT = NULL`
  - `@state_desc NVARCHAR(120) = N'ONLINE'`
  - `@is_read_only BIT = 0`
  - `@is_auto_close_on BIT = NULL`
  - `@is_auto_shrink_on BIT = NULL`
  - `@is_broker_enabled BIT = NULL`
  - `@Help BIT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Enhanced replacement for `sp_MSforeachdb` with filtering by database properties. **Do not modify source.**

#### `sp_ineachdb`
- **Procedure**: `BrentOzar.sp_ineachdb`
- **Parameters**:
  - `@command NVARCHAR(MAX) = NULL`
  - `@replace_character NCHAR(1) = N'?'`
  - `@print_dbname BIT = 0`
  - `@select_dbname BIT = 0`
  - `@print_command BIT = 0`
  - `@print_command_only BIT = 0`
  - `@suppress_quotename BIT = 0`
  - `@system_only BIT = 0`
  - `@user_only BIT = 0`
  - `@name_pattern NVARCHAR(300) = N'%'`
  - `@database_list NVARCHAR(MAX) = NULL`
  - `@exclude_list NVARCHAR(MAX) = NULL`
  - `@recovery_model_desc NVARCHAR(120) = NULL`
  - `@compatibility_level TINYINT = NULL`
  - `@state_desc NVARCHAR(120) = N'ONLINE'`
  - `@is_read_only BIT = 0`
  - `@is_auto_close_on BIT = NULL`
  - `@is_auto_shrink_on BIT = NULL`
  - `@is_broker_enabled BIT = NULL`
  - `@user_access NVARCHAR(128) = NULL`
  - `@Help BIT = 0`
  - `@Version VARCHAR(30) = NULL OUTPUT`
  - `@VersionDate DATETIME = NULL OUTPUT`
  - `@VersionCheckMode BIT = 0`
- **Description**: Execute a command in the context of each database with extensive filtering options. **Do not modify source.**

---

### Minion Integration

#### `minion_index_maint_master`
- **Procedure**: `dbo.Minion_IndexMaintMaster`
- **Parameters**: None
- **Description**: Wrapper to invoke `Minion.IndexMaintMaster` with standard settings.

#### `minion_index_maint_master_direct`
- **Procedure**: `Minion.IndexMaintMaster`
- **Parameters**:
  - `@IndexOption VARCHAR(100) = NULL` — `All`, `ONLINE`, or `OFFLINE`
  - `@ReorgMode VARCHAR(7) = NULL` — `All`, `REORG`, or `REBUILD`
  - `@RunPrepped BIT = 0` — Use pre-collected fragmentation data
  - `@PrepOnly BIT = 0` — Only collect fragmentation stats
  - `@StmtOnly BIT = 0` — Print statements without executing
  - `@Include NVARCHAR(2000) = NULL` — Comma-separated database include list
  - `@Exclude NVARCHAR(2000) = NULL` — Comma-separated database exclude list
  - `@LogProgress BIT = 1` — Log progress to `Minion.IndexMaintLog`
  - `@TestDateTime DATETIME = NULL`
  - `@FailJobOnError BIT = 0`
  - `@FailJobOnWarning BIT = 0`
  - `@Debug BIT = 0`
- **Description**: Minion Enterprise index maintenance master orchestrator. Manages concurrent operations, recovery model changes, and per-database settings. **Do not modify source.**

#### `minion_index_maint_db`
- **Procedure**: `Minion.IndexMaintDB`
- **Parameters**:
  - `@DBName NVARCHAR(400)` — Database name
  - `@IndexOption VARCHAR(7)` — `All`, `ONLINE`, or `OFFLINE`
  - `@ReorgMode VARCHAR(7)` — `All`, `REORG`, or `REBUILD`
  - `@RunPrepped BIT` — Use pre-collected data
  - `@PrepOnly BIT` — Only collect stats
  - `@StmtOnly BIT` — Print only
  - `@LogProgress BIT = 1`
- **Description**: Minion per-database index maintenance worker. **Do not modify source.**

#### `minion_help`
- **Procedure**: `Minion.HELP`
- **Parameters**:
  - `@Module VARCHAR(50) = NULL` — Module name
  - `@Name VARCHAR(100) = NULL` — Object name
  - `@Keyword BIT = 0` — Search by keyword
- **Description**: Minion built-in help system.

#### `minion_clone_settings`
- **Procedure**: `Minion.CloneSettings`
- **Parameters**:
  - `@TableName VARCHAR(512) = 'Minion.BackupSettings'` — Source table
  - `@ID INT` — Row ID to clone
  - `@WithTrans BIT = 1` — Wrap in transaction
  - `@SelectStmt BIT = 1` — Output SELECT statement
  - `@INSERTsql NVARCHAR(MAX) = NULL OUTPUT` — Generated INSERT
- **Description**: Generate INSERT statement to clone a settings row. Change key values (e.g., `DBName`) before executing.

#### `minion_clone_all_settings`
- **Procedure**: `Minion.CloneAllSettings`
- **Parameters**:
  - `@Module VARCHAR(50) = NULL` — Module name
- **Description**: Clone all settings for a Minion module.

#### `minion_db_maint_db_settings_get`
- **Procedure**: `Minion.DBMaintDBSettingsGet`
- **Parameters**:
  - `@Module VARCHAR(25)` — Module name
  - `@DBName VARCHAR(400)` — Database name
  - `@OpName VARCHAR(50)` — Operation name
  - `@SettingID INT OUTPUT` — Returned setting ID
  - `@TestDateTime DATETIME = NULL`
- **Description**: Retrieve database-level maintenance settings for a Minion module.

#### `minion_db_maint_service_check`
- **Procedure**: `Minion.DBMaintServiceCheck`
- **Parameters**:
  - `@ServiceStatus BIT OUTPUT` — 1 = service running
- **Description**: Check if the Minion service is running.

#### `minion_db_maint_status_monitor_on_off`
- **Procedure**: `Minion.DBMaintStatusMonitorONOff`
- **Parameters**:
  - `@Module VARCHAR(25)` — Module name
  - `@Flip VARCHAR(3)` — `ON` or `OFF`
  - `@Version DECIMAL(3,1)` — Minion version
  - `@InstanceName NVARCHAR(128)` — SQL Server instance name
- **Description**: Toggle Minion status monitoring on or off.

---

### DevOps

#### `deploy_environment`
- **Procedure**: `devops.Deploy_Environment_Databases`
- **Parameters**:
  - `@EnvName VARCHAR(50)` — Environment name
- **Description**: Restore databases from Azure blob storage for environment deployment. Remaps synonyms and creates service accounts.

#### `drop_environment`
- **Procedure**: `devops.Drop_Environment_Databases`
- **Parameters**:
  - `@EnvName VARCHAR(128)` — Environment name
- **Description**: Drop all environment-specific databases matching `EnvName_DatabaseName` pattern.

---

### Development Utilities

#### `crud_generator`
- **Procedure**: `dev.CRUD`
- **Parameters**:
  - `@DATABASE VARCHAR(128)` — Database name
  - `@PROCEDURE_NAME VARCHAR(128)` — Output procedure name
  - `@TABLE_NAME VARCHAR(128)` — Source table
  - `@USER_NAME NVARCHAR(100) = NULL` — User name for audit columns
  - `@SHOW_COLUMN_INFO BIT = 0` — Show column metadata
- **Description**: Generate skeleton CRUD stored procedures (SELECT, INSERT, UPDATE, DELETE) for a table.

---

### Job Management

#### `monitor_jobs_by_category`
- **Procedure**: `jobs.Monitor_Jobs_By_Category`
- **Parameters**:
  - `@job_category SYSNAME` — Job category name
  - `@run_date_time DATETIME` — Date/time to check
  - `@target_server VARCHAR(128)` — Target server (`local` or server name)
- **Description**: Poll job execution status for a category with timeout monitoring.

#### `start_jobs_by_category`
- **Procedure**: `jobs.StartJobs_by_Category`
- **Parameters**:
  - `@job_category SYSNAME` — Job category name
  - `@target_server VARCHAR(128)` — Target server
- **Description**: Start all enabled jobs in a category on the target server.

---

### SQL Agent Jobs

#### `job_blocking_monitor_pull`
- **Job**: `DBA - Blocking Monitor Pull`
- **Schedule**: Every 5 minutes
- **Category**: `Database Maintenance`
- **Step**: Executes `[cdre].[BlockingMonitorPullFromRingBuffer]` in `DBAdmin`
- **Description**: Extracts `blocked_process_report` events from the BlockingMonitor Extended Event ring buffer and persists them to `cdre.BlockingLogDetails`. Also auto-restarts the XE session when needed.
- **Related Objects**: `cdre.BlockingMonitorPullFromRingBuffer`, `cdre.BlockingLogDetails`, `cdre.BlockingMonitorLogStatus`

#### `job_runtime_anomaly_detection_job`
- **Job**: `DBA - Job Runtime Anomaly Detection`
- **Schedule**: Every 15 minutes at :10, :25, :40, :55 of each hour
- **Category**: `Database Maintenance`
- **Step**: Executes `[cdre].[JobRuntimeAnomaly_Detection]` in `DBAdmin`
- **Description**: Monitors SQL Agent jobs for runtime anomalies by comparing currently running jobs against baselines stored in `cdre.JobRuntimeBaseline`. Alerts when jobs exceed configured thresholds (e.g., 3x median runtime). Offset by 10 minutes to avoid running at 1:00 AM when baseline update runs.
- **Related Job**: `DBA - Job Runtime Baseline Update`

#### `job_runtime_baseline_update_job`
- **Job**: `DBA - Job Runtime Baseline Update`
- **Schedule**: Daily at 1:00 AM
- **Category**: `Database Maintenance`
- **Step**: Executes `[cdre].[JobRuntimeBaseline_Update]` in `DBAdmin`
- **Description**: Calculates and stores runtime baselines (median, average, percentiles) for all SQL Agent jobs based on historical execution data. Uses outlier detection to exclude abnormal runs from baseline calculations. Results stored in `cdre.JobRuntimeBaseline`.
- **Related Job**: `DBA - Job Runtime Anomaly Detection`

#### `job_query_monitor_pull`
- **Job**: `DBA - Query Monitor Pull`
- **Schedule**: Every 10 minutes
- **Category**: `Database Maintenance`
- **Step**: Executes `[cdre].[QueryMonitorPullFromRingBuffer]` in `DBAdmin`
- **Description**: Extracts query events from the QueryMonitor Extended Event ring buffer and persists them to `cdre.QueryMonitorLogDetails`. Also updates execution plans for recently captured queries and auto-restarts the XE session when needed. Filters are applied from `cdre.QueryMonitorConfig` (INCLUDE/EXCLUDE).
- **Related Objects**: `cdre.QueryMonitorConfig`, `cdre.QueryMonitorLogDetails`, `cdre.QueryMonitorLogStatus`

#### `job_prep_dev_databases`
- **Job**: `Prep Dev Databases`
- **Schedule**: Manual / On-demand
- **Category**: `[Uncategorized (Local)]`
- **Steps**: Multi-step job that restores databases from Azure blob storage, creates development functions, deploys environment databases, and runs post-deployment scripts.
- **Description**: Restore production databases to development environment, apply development-specific modifications (foreign key scripts, synonym remapping), and deploy environment databases via `devops.Deploy_Environment_Databases`.

---

## MCP Resources to Expose

These are data sources the MCP server should expose as resources. Unless otherwise noted, resources are **read-only** (monitoring data, logs, results). Configuration tables are the exception — they MUST be exposed as **read/write** resources so that MCP clients can perform configuration updates (INSERT/UPDATE
