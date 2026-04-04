<!-- MCP_SPEC_META
version: 2026-04-04T23:12:15Z
source_commit: b7dc2bd38e9b6043162739e6204c2d98fa75e103
generator: ai
proc_count: 105
mcp_proc_count: 66
table_count: 52
func_count: 9
view_count: 7
job_count: 6
trigger_count: 1
-->
# SQL-DBAdmin MCP Server Specification

> **Auto-generated** — use this document to build or update an MCP server that exposes this SQL Server DBA toolkit's capabilities as tools and resources.


## MCP Tools to Expose

### Blocking Monitoring

#### `blocking_sessions`
- **Procedure**: `cdre.BlockingSessions`
- **Parameters**: None
- **Description**: Analyze active blocking chains using a recursive CTE against live `sys.dm_exec_requests` and `sys.dm_exec_sessions`. Returns head blockers with full chain hierarchy, SQL text, wait type, and elapsed time. Use for real-time blocking investigation — no parameters, no history required.

#### `blocking_monitor_deploy`
- **Procedure**: `cdre.BlockingMonitorDeploy`
- **Parameters**:
  - `@ThresholdSeconds INT = 15` — Blocked process threshold in seconds; sets the server-level `blocked process threshold` configuration option
  - `@MinutesBetweenRestart INT = 480` — Auto-restart interval for the XE session in minutes
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
- **Description**: Restart the blocking monitor XE session (clears ring buffer). Updates `LastRestart` in `cdre.BlockingMonitorLogStatus`.

#### `blocking_monitor_pull`
- **Procedure**: `cdre.BlockingMonitorPullFromRingBuffer`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
- **Description**: Extract blocking events from the ring buffer, parse XML blocked process reports, and persist to `cdre.BlockingLogDetails`. Captures full blocker and blocked session context including SQL text, login, host, application, database, isolation level, and wait resource. Auto-restarts session based on `MinutesBetweenRestart` from `cdre.BlockingMonitorLogStatus`. Updates `LastPull` and `LastBlockingEvent` timestamps. Schedule every 5 minutes via SQL Agent.

#### `blocking_monitor_status`
- **Procedure**: `cdre.BlockingMonitorStatus`
- **Parameters**: None
- **Returns**: Monitoring status from `cdre.BlockingMonitorLogStatus` including session state, threshold seconds, last pull time, and last blocking event time.

#### `blocking_monitor_analysis`
- **Procedure**: `cdre.BlockingMonitorAnalysis`
- **Parameters**:
  - `@Hours INT = 24` — Hours of history to analyze
  - `@MinDurationMs INT = 0` — Minimum blocking duration in milliseconds to include
  - `@Report VARCHAR(20) = 'summary'` — Report type: `summary`, `topblockers`, `topresources`, or `timeline`
  - `@Debug BIT = 0` — Debug mode
- **Returns**: Report result set based on `@Report` parameter:
  - `summary` — Overall blocking statistics and recent events from `cdre.BlockingLogDetails`
  - `topblockers` — Sessions, logins, and applications causing the most blocking
  - `topresources` — Most frequently blocked wait resources
  - `timeline` — Blocking events over time

#### `blocking_alert_active`
- **Procedure**: `cdre.BlockingAlertActive`
- **Parameters**: None
- **Description**: Return currently open (unresolved) blocking alert events from `cdre.BlockingAlertEvent` where `IsActive = 1`. Shows blocker session, login, program, affected database, detected time, and peak blocked count. Use to determine whether a blocking incident is still ongoing.

#### `blocking_alert_history`
- **Procedure**: `cdre.BlockingAlertHistory`
- **Parameters**:
  - `@Hours INT = 24` — Hours of history to return
- **Description**: Return historical blocking alert events from `cdre.BlockingAlertEvent` within the specified window, including both resolved and active events. Shows event lifecycle: detected time, resolved time, peak blocked count, and alert notification timestamps.

#### `blocking_alert_detail`
- **Procedure**: `cdre.BlockingAlertDetail`
- **Parameters**:
  - `@EventId UNIQUEIDENTIFIER` — Event ID to retrieve detail for (required); obtain from `blocking_alert_history` or `blocking_alert_active`
- **Description**: Return the full snapshot history for a single blocking alert event from `cdre.BlockingAlertSnapshot`. Shows every DMV poll captured during the event, including all sessions in the blocking chain with query text, wait type, elapsed time, CPU, and logical reads.

---

### Deadlocks

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
- **Description**: Restart the deadlock monitoring XE session (clears ring buffer). Updates `LastRestart` in `cdre.DeadLocksLogStatus`.

#### `deadlock_pull`
- **Procedure**: `cdre.DeadlocksPullFromRingBuffer`
- **Parameters**: None
- **Description**: Extract deadlock events from the ring buffer, parse XML deadlock graphs, and persist to `cdre.DeadlocksLogDetails`. Idempotent — deduplicates on `(DeadlockTime, SessionId)`. Auto-restarts session based on `MinutesBetweenRestart` from `cdre.DeadLocksLogStatus`. Updates `LastPull` and `LastDeadLock` timestamps. Schedule every 5–15 minutes via SQL Agent.

#### `deadlock_status`
- **Procedure**: `cdre.DeadlocksStatus`
- **Parameters**: None
- **Returns**: Monitoring status from `cdre.DeadLocksLogStatus` including session state, last pull time, last restart time, and last deadlock time.

#### `deadlock_events`
- **Procedure**: `cdre.DeadlocksEvents`
- **Parameters**:
  - `@StartTime DATETIMEOFFSET = NULL` — Start of time window (NULL = use `@Hours`)
  - `@EndTime DATETIMEOFFSET = NULL` — End of time window (NULL = now)
  - `@Hours INT = 24` — Hours to look back when `@StartTime` is NULL
- **Description**: Return deadlock events from `cdre.DeadlocksLogDetails` within the specified time window. Includes session ID, host, login, application, database, deadlock role, wait resource, wait type, statement, and deadlock graph XML. Useful for targeted investigation of a specific incident window.

#### `deadlock_analysis`
- **Procedure**: `cdre.DeadlocksAnalysis`
- **Parameters**:
  - `@DAYS_BACK INT = 7` — Number of days to analyze
- **Returns**: Multiple result sets including daily deadlock incident counts, trend comparison, top wait resources, top applications involved, top victim queries, and top resource pairs that deadlock together.

---

### Query Monitor

#### `query_monitor_deploy`
- **Procedure**: `cdre.QueryMonitorDeploy`
- **Parameters**: None
- **Description**: Create and start the `QueryMonitor` Extended Event session (captures `sqlserver.sql_statement_completed` events to a ring buffer). Initializes `cdre.QueryMonitorLogStatus`. Part of the three-stage XE monitoring pattern: Deploy → PullFromRingBuffer → Analysis.

#### `query_monitor_destroy`
- **Procedure**: `cdre.QueryMonitorDestroy`
- **Parameters**: None
- **Description**: Stop and drop the `QueryMonitor` XE session. Preserves historical data in `cdre.QueryMonitorLogDetails`.

#### `query_monitor_restart`
- **Procedure**: `cdre.QueryMonitorRestart`
- **Parameters**: None
- **Description**: Restart the query monitoring XE session (clears ring buffer). Updates `LastRestart` in `cdre.QueryMonitorLogStatus`.

#### `query_monitor_pull`
- **Procedure**: `cdre.QueryMonitorPullFromRingBuffer`
- **Parameters**: None
- **Description**: Extract query events from the ring buffer, apply INCLUDE/EXCLUDE filters from `cdre.QueryMonitorConfig`, and persist to `cdre.QueryMonitorLogDetails`. Aggregates execution statistics per query hash. Auto-restarts session based on `MinutesBetweenRestart`. Updates `LastPull`, `LastQueryCaptured`, and `TotalQueriesTracked`. Schedule every 10–15 minutes via SQL Agent.

#### `query_monitor_status`
- **Procedure**: `cdre.QueryMonitorStatus`
- **Parameters**: None
- **Returns**: Status info from `cdre.QueryMonitorLogStatus` including session state, last pull time, last query captured, and total queries tracked.

#### `query_monitor_analysis`
- **Procedure**: `cdre.QueryMonitorAnalysis`
- **Parameters**:
  - `@LoginName NVARCHAR(128) = NULL` — Filter by login name (NULL = all)
  - `@DatabaseName NVARCHAR(128) = NULL` — Filter by database (NULL = all)
  - `@DAYS_BACK INT = 7` — Days of history to analyze
- **Returns**: Multiple result sets including top queries by execution count, average duration, total duration, logical reads, summary by login, and summary by database from `cdre.QueryMonitorLogDetails`.

#### `query_monitor_concurrent_activity`
- **Procedure**: `cdre.QueryMonitorConcurrentActivity`
- **Parameters**:
  - `@StartTime DATETIME2` — Start of window to analyze (required)
  - `@EndTime DATETIME2` — End of window to analyze (required)
  - `@DatabaseName NVARCHAR(128) = NULL` — Filter by database (NULL = all)
- **Description**: Analyze concurrent query activity from `cdre.QueryMonitorLogDetails` to identify overlapping execution windows within a specific time range. Useful for understanding resource contention patterns during an incident.

#### `query_monitor_extract_index_info`
- **Procedure**: `cdre.QueryMonitorExtractIndexInfo`
- **Parameters**:
  - `@QueryId BIGINT = NULL` — Specific query ID to analyze (NULL = all eligible)
  - `@LoginName NVARCHAR(128) = NULL` — Filter by login
  - `@DatabaseName NVARCHAR(128) = NULL` — Filter by database
- **Description**: Parse XML execution plans stored in `cdre.QueryMonitorLogDetails` to identify indexes used and their fragmentation levels. Updates `IndexesUsed` and `IndexFragmentation` fields on matching rows.

---

### User Statements

#### `user_statements_deploy`
- **Procedure**: `cdre.CapturedUserStatementsDeploy`
- **Parameters**: None
- **Description**: Create and start the `Capture_UserStatements_RB` Extended Event session (captures `sqlserver.sql_statement_completed` with ring buffer target). Initializes `cdre.CapturedUserStatementsStatus`. Part of the three-stage XE monitoring pattern: Deploy → PullFromBuffer → Recent.

#### `user_statements_destroy`
- **Procedure**: `cdre.CaptureUserStatementsDestroy`
- **Parameters**: None
- **Description**: Stop and drop the user statement capture XE session. Preserves historical data in `cdre.CapturedUserStatements`.

#### `user_statements_pull`
- **Procedure**: `cdre.CapturedUserStatementsPullFromBuffer`
- **Parameters**: None
- **Description**: Extract user statements from the ring buffer, apply include/exclude filters from `cdre.CapturedUserStatementsConfig`, and persist to `cdre.CapturedUserStatements`. Uses deduplication on `(EventTimeUtc, SessionId, EventName, SqlHash)`. Enforces `RetentionDays` from `cdre.CapturedUserStatementsStatus`.

#### `user_statements_recent`
- **Procedure**: `cdre.CapturedUserStatements_Recent`
- **Parameters**:
  - `@Top INT = 50` — Number of recent statements to return
  - `@LoginName NVARCHAR(128) = NULL` — Filter by login name (NULL = all)
  - `@DatabaseName SYSNAME = NULL` — Filter by database (NULL = all)
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recently captured user statements from `cdre.CapturedUserStatements`, ordered by most recent event time. Includes event time, session ID, database, login, host, application, duration, CPU, logical reads, row count, and SQL text. Useful for real-time visibility into what users are executing.

---

### Index Maintenance

#### `index_analysis`
- **Procedure**: `cdre.IndexAnalysis`
- **Parameters**:
  - `@DatabaseName SYSNAME = NULL` — Database to analyze (required for `unused` report; NULL = all for `missing`)
  - `@SchemaName SYSNAME = NULL` — Filter by schema (NULL = all)
  - `@TableName SYSNAME = NULL` — Filter by table (NULL = all)
  - `@Report NVARCHAR(20) = 'missing'` — Report type: `missing`, `unused`, or `all`
  - `@MinImpact INT = 0` — Minimum estimated impact score to include in missing index results
  - `@Debug BIT = 0` — Debug mode
- **Description**: Analyze missing and unused indexes using DMV data. `missing` report uses `sys.dm_db_missing_index_details`; `unused` report uses `sys.dm_db_index_usage_stats`. `@DatabaseName` is required for the `unused` report.

#### `index_maint_config`
- **Procedure**: `cdre.IndexMaint_Config`
- **Parameters**:
  - `@Database SYSNAME = NULL` — Filter to a specific database (NULL = all)
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display the current effective index maintenance configuration, showing the resolved cascade of settings from the `cdre.IndexMaintConfig_Database`, `cdre.IndexMaintConfig_Schema`, `cdre.IndexMaintConfig_Table`, and `cdre.IndexMaintConfig_Index` tables.

#### `index_maint_history`
- **Procedure**: `cdre.IndexMaintIndexHistory`
- **Parameters**:
  - `@Database SYSNAME` — Database name (required)
  - `@Schema SYSNAME = NULL` — Schema filter (NULL = all)
  - `@Table SYSNAME = NULL` — Table filter (NULL = all)
  - `@Index SYSNAME = NULL` — Index filter (NULL = all)
  - `@Last INT = 10` — Number of recent records to return
  - `@Debug BIT = 0` — Debug mode
- **Description**: Query historical index maintenance operations for a specific index or set of indexes from `cdre.IndexMaintHistoryDetails`. Shows fragmentation before and after, maintenance action taken, duration, and thresholds applied.

#### `index_maint_job_review`
- **Procedure**: `cdre.IndexMaintJobReview`
- **Parameters**:
  - `@JobsAgo INT = 1` — Which execution to review (1 = most recent)
  - `@Debug BIT = 0` — Debug mode
- **Description**: Review an index maintenance job execution with summary statistics, per-database breakdown, and stuck index detection from `cdre.IndexMaintHistory` and `cdre.IndexMaintHistoryDatabases`. Useful for post-maintenance validation.

---

### Jobs

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
  - `@FailuresOnly BIT = 0` — Return only failed runs when set to 1
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

#### `job_runtime_baselines`
- **Procedure**: `cdre.JobRuntimeBaselines`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return the current stored baseline statistics for all SQL Agent jobs from `cdre.JobRuntimeBaseline`. Shows median, average, min, max, and percentile (P75, P90, P95) runtimes, outlier exclusion counts, and calculation metadata.

#### `job_runtime_anomaly_detection`
- **Procedure**: `cdre.JobRuntimeAnomaly_Detection`
- **Parameters**:
  - `@Debug BIT = 0` — Show detailed debug output
  - `@Help BIT = 0` — Display help information
- **Description**: Detect currently running SQL Agent jobs that exceed baseline thresholds. Compares running jobs against baselines stored in `cdre.JobRuntimeBaseline`. Uses `RuntimeThresholdMultiplier` (default 3×), `MinimumRuntimeMinutes`, and `MaximumRuntimeMinutes` from `cdre.JobRuntimeAnomalyConfig`. Prerequisite: baselines must be calculated first via the `DBA - Job Runtime Baseline Update` job. Run every 15 minutes via the `DBA - Job Runtime Anomaly Detection` job.

#### `msdb_failed_jobs`
- **Procedure**: `cdre.Msdb_FailedJobs`
- **Parameters**:
  - `@DaysBack INT = 1` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recently failed SQL Agent jobs from `msdb`, showing job name, step, error message, and failure time.

---

### Maintenance

#### `maintenance_results`
- **Procedure**: `cdre.Maintenance_Results`
- **Parameters**:
  - `@Operation VARCHAR(100) = NULL` — Filter by operation type (NULL = all)
  - `@DaysBack INT = 7` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recent maintenance operation results from `cdre.MaintenanceResults`, showing DBCC, statistics update, and other maintenance outcomes with status and duration.

#### `invalid_objects_report`
- **Procedure**: `cdre.InvalidObjects_Report`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report on invalid objects found across databases from `cdre.InvalidObjects`. Groups by database and object type, showing object name, error message, and detection timestamp.

#### `storage_usage_database`
- **Procedure**: `cdre.StorageUsage_Database`
- **Parameters**:
  - `@DatabaseName SYSNAME = NULL` — Filter to a specific database (NULL = all)
  - `@DaysBack INT = 30` — Days of history to include
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report current and historical database size trends from `cdre.SizeLogs_Database`. Shows total, data, and log size over time to identify growth patterns.

#### `storage_usage_tables`
- **Procedure**: `cdre.StorageUsage_Tables`
- **Parameters**:
  - `@DatabaseName SYSNAME = NULL` — Filter to a specific database (NULL = all)
  - `@TableName SYSNAME = NULL` — Filter to a specific table (NULL = all)
  - `@DaysBack INT = 30` — Days of history to include
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Report current and historical table size trends from `cdre.SizeLogs_Tables`. Shows the largest tables and growth patterns over time.

#### `msdb_maintenance_plans`
- **Procedure**: `cdre.Msdb_MaintenancePlans`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return SQL Server Maintenance Plan definitions and last execution status from `msdb`.

---

### System Health

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

#### `resolve_wait_resource`
- **Procedure**: `cdre.ResolveWaitResource`
- **Parameters**:
  - `@WaitResource NVARCHAR(256)` — Wait resource string to resolve (required); e.g., `KEY: 5:72057594038321152 (8194443284a0)`, `PAGE: 5:1:12345`, `RID: 5:1:12345:0`
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Resolve a SQL Server wait resource string to a human-readable object name (database, schema, table, index). Handles KEY, PAGE, RID, and OBJECT lock types. Uses `DBCC PAGE` for page-level resolution. System/IAM/GAM pages return a descriptive error row rather than crashing. For KEY locks, resolves via `sys.dm_tran_locks` `hobt_id`.

#### `user_mapping`
- **Procedure**: `cdre.UserMapping`
- **Parameters**: None
- **Description**: Report user-to-database-principal-role-permission mappings across all databases. Useful for security audits and access reviews.

#### `schema_change_log`
- **Procedure**: `cdre.SchemaChangeLog`
- **Parameters**:
  - `@DaysBack INT = 7` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recent schema change events from `dev.SchemaChangeLog`, showing DDL changes captured by the `dev_trg_LogSchemaChanges` database trigger. Includes event type, object name, login, program, and the T-SQL command executed.

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
  - `@ErrorProcedure NVARCHAR(200) = NULL` — Filter by procedure name (NULL = all)
  - `@LoginName NVARCHAR(200) = NULL` — Filter by login name (NULL = all)
  - `@Severity INT = NULL` — Filter by error severity (NULL = all)
  - `@MessageSearch NVARCHAR(500) = NULL` — Filter by message text substring (NULL = all)
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

### Configuration

#### `config_alerts`
- **Procedure**: `cdre.Config_Alerts`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display alert configuration from `dbo.AlertConfig` and `dbo.NotificationTargets`, showing active alerts, severity levels, and notification targets.

#### `config_blitz_skip_checks`
- **Procedure**: `cdre.Config_BlitzSkipChecks`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display current `BrentOzar.Config_Blitz_SkipChecks` entries showing which Blitz health check IDs are suppressed and for which server/database combinations.

#### `config_deadlock_monitor`
- **Procedure**: `cdre.Config_DeadlockMonitor`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display deadlock monitor configuration from `cdre.DeadLocksLogStatus`, showing current session state, restart interval, and last event timestamps.

#### `config_query_monitor`
- **Procedure**: `cdre.Config_QueryMonitor`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display query monitor configuration from `cdre.QueryMonitorConfig` and `cdre.QueryMonitorLogStatus`, showing active INCLUDE/EXCLUDE filters and session state.

#### `config_settings`
- **Procedure**: `cdre.Config_Settings`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Display general DBA toolkit settings from `cdre.SettingsDB` and related configuration tables, showing database exclusions and execution settings.

---

### DevOps

#### `deploy_environment`
- **Procedure**: `devops.Deploy_Environment_Databases`
- **Parameters**:
  - `@EnvName VARCHAR(50)` — Environment name (required)
- **Description**: Restore databases from Azure blob storage for environment deployment. Remaps synonyms and creates service accounts for the target environment.

#### `drop_environment`
- **Procedure**: `devops.Drop_Environment_Databases`
- **Parameters**:
  - `@EnvName VARCHAR(128)` — Environment name (required)
- **Description**: Drop all environment-specific databases matching the `EnvName_DatabaseName` naming pattern. Use with caution — this is destructive.

---

### Development

#### `schema_change_log_dev`
- **Procedure**: `cdre.SchemaChangeLog`
- **Parameters**:
  - `@DaysBack INT = 7` — Days of history to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return recent schema change events captured by the `dev_trg_LogSchemaChanges` DDL trigger. Shows object-level DDL history including before/after object definitions via the `dev.SchemaChanges` view. Useful for auditing recent deployments or tracking unintended schema changes.

#### `activity_monitor`
- **Procedure**: `dbo.ActivityMonitor`
- **Parameters**:
  - `@ShowDetails BIT = 0` — Show SQL text for active sessions
  - `@HideDbs VARCHAR(MAX) = 'master,msdb,'` — Comma-separated databases to hide
  - `@HideLogins VARCHAR(MAX) = 'sa'` — Comma-separated logins to hide
  - `@ShowLogins VARCHAR(MAX) = ''` — Only show these logins (empty = all)
  - `@ShowDbs VARCHAR(MAX) = ''` — Only show these databases (empty = all)
  - `@BlockingRelevantOnly BIT = 0` — Show only sessions involved in blocking
  - `@CommandSearch VARCHAR(MAX) = ''` — Filter by command text substring
- **Description**: Display active sessions with blocking chain analysis, filtering, and search capabilities. Parses `sys.dm_exec_sessions` and `sys.dm_exec_requests` with configurable filters.

#### `sp_blitz`
- **Procedure**: `BrentOzar.sp_Blitz`
- **Parameters**:
  - `@Help TINYINT = 0`
  - `@CheckUserDatabaseObjects TINYINT = 1`
  - `@CheckProcedureCache TINYINT = 0`
  - `@OutputType VARCHAR(20) = 'TABLE'`
  - `@CheckServerInfo TINYINT = 0`
  - `@IgnorePrioritiesBelow INT = NULL`
  - `@IgnorePrioritiesAbove INT = NULL`
  - `@SummaryMode TINYINT = 0`
  - `@BringThePain TINYINT = 0`
  - `@Debug TINYINT = 0`
- **Description**: Third-party First Responder Kit server health check. Returns prioritized findings across configuration, security, and performance categories. Customized with skip checks for standard service accounts and accepted configuration values. **Do not modify source.** Configure via `BrentOzar.Config_Blitz_SkipChecks`.

#### `sp_blitz_cache`
- **Procedure**: `BrentOzar.sp_BlitzCache`
- **Parameters**:
  - `@Help BIT = 0`
  - `@Top INT = NULL`
  - `@SortOrder VARCHAR(50) = 'CPU'` — Sort by: `CPU`, `reads`, `duration`, `executions`, `writes`, `memory grant`, `spills`
  - `@ExpertMode TINYINT = 0`
  - `@DurationFilter DECIMAL(38,4) = NULL`
  - `@IgnoreSystemDBs BIT = 1`
  - `@DatabaseName NVARCHAR(128) = NULL`
  - `@StoredProcName NVARCHAR(128) = NULL`
  - `@MinimumExecutionCount INT = 0`
  - `@MinutesBack INT = NULL`
  - `@Debug BIT = 0`
- **Description**: Analyze plan cache for resource-intensive queries. Sort by CPU, reads, duration, executions, etc. **Do not modify source.**

#### `sp_blitz_first`
- **Procedure**: `BrentOzar.sp_BlitzFirst`
- **Parameters**:
  - `@Help TINYINT = 0`
  - `@ExpertMode TINYINT = 0`
  - `@Seconds INT = 5`
  - `@OutputType VARCHAR(20) = 'TABLE'`
  - `@CheckProcedureCache TINYINT = 0`
  - `@CheckServerInfo TINYINT = 1`
  - `@FileLatencyThresholdMS INT = 100`
  - `@SinceStartup TINYINT = 0`
  - `@Debug BIT = 0`
- **Description**: Real-time server performance snapshot — waits, file stats, and perfmon counters sampled over `@Seconds`. **Do not modify source.**

## MCP Resources to Expose

These are data sources the MCP server should expose as resources. Unless otherwise noted, resources are **read-only** (monitoring data, logs, results). Configuration tables are the exception — they should be exposed as **read/write** resources so that MCP clients can perform configuration updates (INSERT/UPDATE/DELETE) without requiring raw SQL access.

---

### Blocking Alert Configuration

#### `resource://cdre/blocking-alert-config`
- **Table**: `cdre.BlockingAlertConfig`
- **Access**: Read/Write
- **Description**: Controls the `cdre.BlockingAlertMonitor` DMV-based blocking alert system. Each row is a typed rule. Operators add rows to define which databases to watch, which logins/programs to exclude, and what threshold to apply. The `MatchType` column supports exact or `LIKE`-style matching.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `ConfigId` | `INT IDENTITY` | No | — | Surrogate primary key |
| `ConfigType` | `NVARCHAR(50)` | No | — | Rule type: `ThresholdSeconds`, `RetentionDays`, `NotificationName`, `WatchDatabase`, `ExcludeLogin`, `ExcludeProgram` |
| `Value` | `NVARCHAR(512)` | No | — | The value for the rule (e.g., database name, login name, seconds) |
| `MatchType` | `NVARCHAR(10)` | No | `'Exact'` | `Exact` or `Like` — controls whether `Value` is matched literally or with `LIKE` |
| `IsEnabled` | `BIT` | No | `1` | Whether this rule is active |
| `Notes` | `NVARCHAR(500)` | Yes | NULL | Free-text operator notes |

---

### Notification Targets

#### `resource://cdre/notification-targets`
- **Table**: `cdre.NotificationTargets`
- **Access**: Read/Write
- **Description**: Email notification recipients grouped by a logical `NotificationName`. The blocking alert monitor and other alerting procedures look up recipients by name. Multiple rows with the same `NotificationName` send to multiple addresses.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `TargetId` | `INT IDENTITY` | No | — | Surrogate primary key |
| `NotificationName` | `NVARCHAR(100)` | No | — | Logical group name referenced by alert procedures (e.g., `BlockingAlert`) |
| `NotificationTarget` | `NVARCHAR(500)` | No | — | Email address or distribution list |
| `MailProfile` | `NVARCHAR(100)` | No | `'Email'` | Database Mail profile name to use for sending |
| `IsEnabled` | `BIT` | No | `1` | Whether this recipient is active |
| `Notes` | `NVARCHAR(500)` | Yes | NULL | Free-text operator notes |

---

### Query Monitor Configuration

#### `resource://cdre/query-monitor-config`
- **Table**: `cdre.QueryMonitorConfig`
- **Access**: Read/Write
- **Description**: INCLUDE/EXCLUDE filter rules applied when `cdre.QueryMonitorPullFromRingBuffer` processes ring buffer events. Rows with `FilterType = 'INCLUDE'` restrict capture to matching sessions; rows with `FilterType = 'EXCLUDE'` suppress matching sessions. NULL columns act as wildcards.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Id` | `INT IDENTITY` | No | — | Surrogate primary key |
| `LoginName` | `NVARCHAR(128)` | Yes | NULL | Login name to match (NULL = any login) |
| `DatabaseName` | `NVARCHAR(128)` | Yes | NULL | Database name to match (NULL = any database) |
| `AppNameFilter` | `NVARCHAR(256)` | Yes | NULL | Application name to match (NULL = any application) |
| `TextFilter` | `NVARCHAR(500)` | Yes | NULL | SQL text substring to match (NULL = any text) |
| `FilterType` | `VARCHAR(10)` | No | `'INCLUDE'` | `INCLUDE` or `EXCLUDE` — direction of the filter |
| `IsActive` | `BIT` | No | `1` | Whether this filter rule is currently applied |
| `CreatedDate` | `DATETIMEOFFSET` | No | `SYSUTCDATETIME()` | When the rule was created |
| `ModifiedDate` | `DATETIMEOFFSET` | Yes | NULL | When the rule was last modified |

---

### Blocking Monitor Status

#### `resource://cdre/blocking-monitor-status`
- **Table**: `cdre.BlockingMonitorLogStatus`
- **Access**: Read-only
- **Description**: Single-row state table for the `BlockingMonitor` Extended Event session. Used by `cdre.BlockingMonitorStatus` and `cdre.BlockingMonitorPullFromRingBuffer` to track session health, auto-restart timing, and last activity. Query this to determine whether the XE session is running and when it last captured data.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Status` | `CHAR(1)` | Yes | NULL | Session state: `R` = Running, `S` = Stopped |
| `ThresholdSeconds` | `INT` | Yes | NULL | The `blocked process threshold` value set when the session was deployed |
| `RunningSince` | `DATETIMEOFFSET` | Yes | NULL | When the current session was started |
| `LastPull` | `DATETIMEOFFSET` | Yes | NULL | When `BlockingMonitorPullFromRingBuffer` last ran successfully |
| `LastRestart` | `DATETIMEOFFSET` | Yes | NULL | When the session was last auto-restarted |
| `MinutesBetweenRestart` | `INT` | Yes | NULL | Auto-restart interval configured at deploy time |
| `LastBlockingEvent` | `DATETIMEOFFSET` | Yes | NULL | Timestamp of the most recently captured blocking event |

---

### Deadlock Monitor Status

#### `resource://cdre/deadlock-monitor-status`
- **Table**: `cdre.DeadLocksLogStatus`
- **Access**: Read-only
- **Description**: Single-row state table for the `DeadlockMonitor` Extended Event session. Tracks session health, last pull time, and last deadlock captured. Query this to verify the deadlock monitor is running and active.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Status` | `CHAR(1)` | Yes | NULL | Session state: `R` = Running, `S` = Stopped |
| `RunningSince` | `DATETIMEOFFSET` | Yes | NULL | When the current session was started |
| `LastPull` | `DATETIMEOFFSET` | Yes | NULL | When `DeadlocksPullFromRingBuffer` last ran successfully |
| `LastRestart` | `DATETIMEOFFSET` | Yes | NULL | When the session was last auto-restarted |
| `MinutesBetweenRestart` | `INT` | Yes | NULL | Auto-restart interval |
| `LastDeadLock` | `DATETIMEOFFSET` | Yes | NULL | Timestamp of the most recently captured deadlock event |

---

### Query Monitor Status

#### `resource://cdre/query-monitor-status`
- **Table**: `cdre.QueryMonitorLogStatus`
- **Access**: Read-only
- **Description**: Single-row state table for the `QueryMonitor` Extended Event session. Tracks session health, last pull time, and aggregate query capture statistics. Query this to verify the query monitor is running and to see how many queries have been captured.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Status` | `CHAR(1)` | Yes | NULL | Session state: `R` = Running, `S` = Stopped |
| `RunningSince` | `DATETIMEOFFSET` | Yes | NULL | When the current session was started |
| `LastPull` | `DATETIMEOFFSET` | Yes | NULL | When `QueryMonitorPullFromRingBuffer` last ran successfully |
| `LastRestart` | `DATETIMEOFFSET` | Yes | NULL | When the session was last auto-restarted |
| `MinutesBetweenRestart` | `INT` | Yes | NULL | Auto-restart interval |
| `LastQueryCaptured` | `DATETIMEOFFSET` | Yes | NULL | Timestamp of the most recently captured query event |
| `TotalQueriesTracked` | `INT` | Yes | NULL | Running count of distinct query hashes tracked in `cdre.QueryMonitorLogDetails` |

---

### User Statement Capture Status

#### `resource://cdre/user-statements-status`
- **Table**: `cdre.CapturedUserStatementsStatus`
- **Access**: Read-only
- **Description**: Single-row state table for the `Capture_UserStatements_RB` Extended Event session. Tracks session health, last pull time, and retention policy. Query this to verify the user statement capture session is running.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Status` | `CHAR(1)` | Yes | NULL | Session state: `R` = Running, `S` = Stopped |
| `MinutesBetweenRestart` | `INT` | Yes | NULL | Auto-restart interval |
| `LastEventTime` | `DATETIME2` | Yes | NULL | Timestamp of the most recently captured statement event |
| `LastPull` | `DATETIME2` | Yes | NULL | When `CapturedUserStatementsPullFromBuffer` last ran successfully |
| `LastRestart` | `DATETIME2` | Yes | NULL | When the session was last auto-restarted |
| `RetentionDays` | `INT` | Yes | NULL | How many days of captured statements to retain in `cdre.CapturedUserStatements` |

---

### User Statement Capture Configuration

#### `resource://cdre/user-statements-config`
- **Table**: `cdre.CapturedUserStatementsConfig`
- **Access**: Read/Write
- **Description**: Filter rules for the user statement capture system. Controls which logins are included and which programs or logins are excluded when pulling from the ring buffer.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Include_UserId` | `NVARCHAR(256)` | Yes | NULL | Login name to explicitly include (NULL = no include filter) |
| `Exclude_Program` | `NVARCHAR(256)` | Yes | NULL | Application name pattern to exclude |
| `Exclude_UserId` | `NVARCHAR(256)` | Yes | NULL | Login name to exclude |
| `Enabled` | `BIT` | No | `1` | Whether this configuration row is active |

---

### Index Maintenance Configuration — Database Level

#### `resource://cdre/index-maint-config-database`
- **Table**: `cdre.IndexMaintConfig_Database`
- **Access**: Read/Write
- **Description**: Database-level index maintenance thresholds. Settings here override server defaults and are inherited by all schemas, tables, and indexes in the named database unless overridden at a lower level. Set `Ignore = 1` to skip an entire database.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Database` | `SYSNAME` | No | — | Database name this configuration applies to |
| `Ignore` | `BIT` | Yes | `0` | Skip this database entirely during index maintenance |
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % at or above which REORGANIZE is performed (NULL = inherit) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % at or above which REBUILD is performed (NULL = inherit) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count required before maintenance is considered (NULL = inherit) |

---

### Index Maintenance Configuration — Schema Level

#### `resource://cdre/index-maint-config-schema`
- **Table**: `cdre.IndexMaintConfig_Schema`
- **Access**: Read/Write
- **Description**: Schema-level index maintenance thresholds. Overrides database-level settings for all tables in the named schema. NULL values inherit from the database level.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Database` | `SYSNAME` | No | — | Database containing the schema |
| `Schema` | `SYSNAME` | No | — | Schema name this configuration applies to |
| `Ignore` | `BIT` | Yes | `0` | Skip all indexes in this schema |
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REORGANIZE (NULL = inherit from database) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REBUILD (NULL = inherit from database) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count threshold (NULL = inherit from database) |

---

### Index Maintenance Configuration — Table Level

#### `resource://cdre/index-maint-config-table`
- **Table**: `cdre.IndexMaintConfig_Table`
- **Access**: Read/Write
- **Description**: Table-level index maintenance thresholds. Overrides schema-level settings for all indexes on the named table. NULL values inherit from the schema level.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Database` | `SYSNAME` | No | — | Database containing the table |
| `Schema` | `SYSNAME` | No | — | Schema containing the table |
| `Table` | `SYSNAME` | No | — | Table name this configuration applies to |
| `Ignore` | `BIT` | Yes | `0` | Skip all indexes on this table |
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REORGANIZE (NULL = inherit from schema) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REBUILD (NULL = inherit from schema) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count threshold (NULL = inherit from schema) |

---

### Index Maintenance Configuration — Index Level

#### `resource://cdre/index-maint-config-index`
- **Table**: `cdre.IndexMaintConfig_Index`
- **Access**: Read/Write
- **Description**: Index-level maintenance thresholds — the most granular level of the configuration cascade. Settings here override all higher levels. NULL values inherit from the table level.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Database` | `SYSNAME` | No | — | Database containing the index |
| `Schema` | `SYSNAME` | No | — | Schema containing the table |
| `Table` | `SYSNAME` | No | — | Table containing the index |
| `Index` | `SYSNAME` | No | — | Index name this configuration applies to |
| `Ignore` | `BIT` | Yes | `0` | Skip this specific index during maintenance |
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REORGANIZE (NULL = inherit from table) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REBUILD (NULL = inherit from table) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count threshold (NULL = inherit from table) |

---

### Job Runtime Anomaly Configuration

#### `resource://cdre/job-runtime-anomaly-config`
- **Table**: `cdre.JobRuntimeAnomalyConfig`
- **Access**: Read/Write
- **Description**: Per-job or per-category thresholds for the job runtime anomaly detection system. Controls how baselines are calculated and when alerts fire. Rows can target a specific `JobName`, a `CategoryName` (applies to all jobs in the category), or both. NULL in both columns applies as a global default.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Id` | `INT IDENTITY` | No | — | Surrogate primary key |
| `JobName` | `SYSNAME` | Yes | NULL | Specific job name to configure (NULL = match by category or global) |
| `CategoryName` | `SYSNAME` | Yes | NULL | Job category to configure (NULL = match by job name or global) |
| `RuntimeThresholdMultiplier` | `DECIMAL(5,2)` | No | `3.0` | Alert when current runtime exceeds baseline × this multiplier |
| `MinimumRuntimeMinutes` | `INT` | No | `30` | Jobs running less than this many minutes are not flagged |
| `MaximumRuntimeMinutes` | `INT` | Yes | NULL | Jobs running longer than this are always flagged regardless of baseline (NULL = no cap) |
| `ExcludeOutliers` | `BIT` | No | `1` | Whether to exclude outlier runs when calculating the baseline |
| `OutlierMethod` | `VARCHAR(20)` | No | `'IQR'` | Outlier detection method: `IQR`, `StdDev`, or `Percentile` |
| `OutlierThreshold` | `DECIMAL(5,2)` | Yes | `1.5` | Sensitivity for the outlier method (e.g., 1.5 = 1.5× IQR) |
| `ExcludeHistoricalMaxMinutes` | `INT` | Yes | NULL | Exclude historical runs longer than this from baseline calculation (NULL = no exclusion) |
| `UseMedianInsteadOfAvg` | `BIT` | No | `1` | Use median runtime as the baseline reference instead of average |
| `IsActive` | `BIT` | No | `1` | Whether this configuration row is active |
| `NotifyEmail` | `VARCHAR(255)` | Yes | NULL | Email address to notify when an anomaly is detected |
| `CreatedDate` | `DATETIME` | No | `GETDATE()` | When this row was created |
| `ModifiedDate` | `DATETIME` | Yes | NULL | When this row was last modified |

---

### Job Runtime Baselines

#### `resource://cdre/job-runtime-baselines`
- **Table**: `cdre.JobRuntimeBaseline`
- **Access**: Read-only
- **Description**: Calculated baseline statistics for each SQL Agent job, updated daily by the `DBA - Job Runtime Baseline Update` job. One row per `job_id`. Used by `cdre.JobRuntimeAnomaly_Detection` to compare currently running jobs against historical norms.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Id` | `INT IDENTITY` | No | — | Surrogate primary key |
| `job_id` | `UNIQUEIDENTIFIER` | No | — | SQL Agent job ID (unique — one baseline per job) |
| `job_name` | `SYSNAME` | No | — | Job name at time of baseline calculation |
| `category_name` | `SYSNAME` | Yes | NULL | Job category at time of calculation |
| `CalculatedDate` | `DATETIME` | No | — | When this baseline was last calculated |
| `LookbackDays` | `INT` | No | — | Days of history used for the calculation |
| `SuccessfulRuns` | `INT` | No | — | Total successful runs found in the lookback window |
| `SuccessfulRunsAfterFilter` | `INT` | No | — | Successful runs remaining after outlier exclusion |
| `OutliersExcluded` | `INT` | No | — | Number of runs excluded as outliers |
| `AvgRuntimeSeconds` | `INT` | No | — | Mean runtime across filtered runs |
| `MedianRuntimeSeconds` | `INT` | No | — | Median runtime across filtered runs |
| `MinRuntimeSeconds` | `INT` | No | — | Minimum runtime across filtered runs |
| `MaxRuntimeSeconds` | `INT` | No | — | Maximum runtime across filtered runs |
| `StdDevRuntimeSeconds` | `INT` | Yes | NULL | Standard deviation of runtime across filtered runs |
| `P75RuntimeSeconds` | `INT` | Yes | NULL | 75th percentile runtime |
| `P90RuntimeSeconds` | `INT` | Yes | NULL | 90th percentile runtime |
| `P95RuntimeSeconds` | `INT` | Yes | NULL | 95th percentile runtime |
| `BaselineRuntimeSeconds` | `INT` | No | — | The runtime used for anomaly comparison (median or avg per config) |
| `UseMedianInsteadOfAvg` | `BIT` | No | — | Whether median was used as the baseline reference |

---

### Blitz Skip Checks

#### `resource://BrentOzar/blitz-skip-checks`
- **Table**: `BrentOzar.Config_Blitz_SkipChecks`
- **Access**: Read/Write
- **Description**: Suppresses specific `sp_Blitz` health check findings. Add a row to permanently silence a check for a given server/database combination. NULL in `ServerName` or `DatabaseName` acts as a wildcard. **Do not modify the `BrentOzar` schema objects themselves** — this table is the approved configuration interface.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `ServerName` | `NVARCHAR(128)` | Yes | NULL | Server name to suppress the check on (NULL = all servers) |
| `DatabaseName` | `NVARCHAR(128)` | Yes | NULL | Database name to suppress the check for (NULL = all databases) |
| `CheckID` | `INT` | Yes | NULL | The `sp_Blitz` check ID to suppress |

---

### Database Exclusion Settings

#### `resource://cdre/settings-db`
- **Table**: `cdre.SettingsDB`
- **Access**: Read/Write
- **Description**: Controls which databases are excluded from specific maintenance operations (DBCC CheckDB, statistics updates, etc.). Each row associates a database name with a named operation. Set `Exclude = 1` to skip the database for that operation.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `ExecName` | `NVARCHAR(256)` | Yes | NULL | Operation name that reads this exclusion list (e.g., `CheckDB`, `UpdateStats`) |
| `DatabaseName` | `NVARCHAR(128)` | Yes | NULL | Database to exclude from the named operation |
| `Exclude` | `BIT` | Yes | `1` | Whether to exclude this database (1 = exclude) |

## MCP Server Implementation Notes

### Connection Configuration

The MCP server connects to a single **administrative database** (conventionally named `DBAdmin`) on a SQL Server 2016+ instance or Azure Managed Instance. All `cdre.*`, `dbo.*`, `dev.*`, `devops.*`, and `jobs.*` objects reside in this one database. The connection string must be configured as an environment variable or application setting — there is no runtime database selection for the primary admin connection.

**Required connection string settings:**
- `Database` / `Initial Catalog`: The admin database name (e.g., `DBAdmin`)
- `Server`: SQL Server instance name or Azure Managed Instance FQDN
- Authentication: SQL Server Authentication or Windows Authentication (Integrated Security)
- `MultipleActiveResultSets=True` — several procedures return multiple result sets
- `Connect Timeout`: Recommend ≥ 30 seconds; some maintenance procedures (index maint, DBCC) run long
- `Command Timeout`: Set per-tool — use a short timeout (30s) for status/query tools, and a long or unlimited timeout (0) for maintenance operations such as `cdre.IndexMaint` and `cdre.Maintenance_DBCCCheckDB`

**Secondary connections (cross-database tools):**
- `cdre.DataSync_QueueStatus` uses a dynamic database name sourced from an environment variable — this is a known legacy exception tracked in `TODO.md` and uses `ExecuteQueryAsync` rather than `ExecuteProcedureAsync`
- `cdre.Evo_ErrorLog` and `cdre.Evo_ErrorLogSummary` query a separate application database — also a tracked legacy exception
- All other tools connect exclusively to the admin database

### Authentication and Authorization

The SQL login used by the MCP server requires:
- `EXECUTE` permission on all `cdre.*`, `dbo.*`, `dev.*`, `devops.*`, and `jobs.*` procedures
- `SELECT` on all `cdre.*`, `BrentOzar.*`, `Minion.*`, `dev.*`, and `dbo.*` tables and views
- `VIEW SERVER STATE` — required by blocking, query monitor, and activity monitor tools that query DMVs (`sys.dm_exec_requests`, `sys.dm_exec_sessions`, `sys.dm_tran_locks`, etc.)
- `VIEW DATABASE STATE` — required for XE ring buffer access and `sys.dm_db_index_physical_stats`
- `ALTER SETTINGS` — required by `cdre.BlockingMonitorDeploy` (sets `blocked process threshold` via `sp_configure`)
- Access to `msdb` — required by job history procedures (`cdre.Job_History`, `cdre.JobStepHistory`, `cdre.Msdb_*`) which query `msdb.dbo.sysjobs`, `msdb.dbo.sysjobhistory`, `msdb.dbo.suspect_pages`, etc.

For the SaaS/central-polling architecture, the Worker Service uses JWT bearer + API key dual authentication with reader/operator/admin RBAC tiers. Reader-tier tokens should be restricted from calling destructive procedures (`*Destroy`, `*Deploy`, `devops.Drop_*`).

### Calling Convention

**All tool methods must call `SqlQueryHelper.ExecuteProcedureAsync`** — never `ExecuteQueryAsync` in tool files (except the three tracked legacy exceptions). Every tool maps 1:1 to a `cdre.*` stored procedure. When adding a new tool, create the stored procedure first, then wire the C# to call it.

Procedure calls follow the pattern:
```
EXEC [cdre].[ProcedureName] @Param1 = @value1, @Param2 = @value2
```

Parameters with defaults do not need to be passed unless overriding the default. The `@Debug BIT = 0` and `@Help BIT = 0` parameters present on most `cdre.*` procedures should be exposed as optional tool parameters; `@Debug = 1` causes procedures to emit `RAISERROR ... WITH NOWAIT` progress messages and may return additional diagnostic result sets.

### Error Handling Patterns

All `cdre.*` procedures use `TRY/CATCH` blocks internally. The MCP server should:

1. **Propagate SQL errors** — catch `SqlException` and surface the error message and severity to the MCP client. SQL Server severity ≥ 16 indicates a procedure-level error; severity 11–15 are warnings.
2. **Handle multiple result sets** — many analysis and status procedures return 2–5 result sets. The C# layer must read all result sets in order using `NextResultAsync()`. Stopping after the first result set will leave the connection in a dirty state.
3. **Handle empty result sets gracefully** — status procedures (e.g., `cdre.BlockingMonitorStatus`, `cdre.DeadlocksStatus`) return empty sets when no data has been collected yet. This is not an error.
4. **Respect `RAISERROR WITH NOWAIT`** — progress messages from long-running procedures (index maintenance, DBCC) are emitted as informational messages (severity 0–10) via `SqlConnection.InfoMessage`. Wire up the `InfoMessage` event handler to stream these to the MCP client as progress notifications rather than discarding them.
5. **Timeout handling** — maintenance procedures (`cdre.IndexMaint`, `cdre.Maintenance_DBCCCheckDB`, `cdre.Maintenance_UpdateAllStats`) should use `CommandTimeout = 0` (unlimited). Status and query tools should use a bounded timeout (30–60 seconds).

### Database Targeting: Admin DB vs. Target DBs

The toolkit uses a **central admin database model** — all procedures, tables, and configuration live in the single admin database. Procedures that need to inspect other databases do so internally via:

- **Dynamic SQL with `USE [database]`** — used by `cdre.IndexMaint`, `cdre.Maintenance_DBCCCheckDB`, `cdre.Maintenance_UpdateAllStats`, and `cdre.Maintenance_FindInvalidObjects`. The MCP server passes database names as parameters; the procedures handle cross-database execution internally.
- **`BrentOzar.sp_foreachdb` / `BrentOzar.sp_ineachdb`** — used for multi-database operations. The MCP server does not need to iterate databases itself.
- **`msdb` queries** — job history, alert history, suspect pages, and maintenance plan procedures query `msdb` directly. The SQL login must have appropriate `msdb` access.
- **`sys.databases` / DMV queries** — server-scope views are accessible from the admin database context with `VIEW SERVER STATE`.

The MCP server **never needs to switch its connection's database context** — all calls go to the admin database, and procedures handle any cross-database work internally.

For the `cdre.IndexAnalysis` procedure with `@Report = 'unused'`, the `@DatabaseName` parameter is required (the procedure queries `sys.dm_db_index_usage_stats` in the context of the target database via dynamic SQL). Validate that `@DatabaseName` is provided before calling when `@Report = 'unused'` or `'all'`.

### Extended Events Monitoring Architecture

The three XE monitoring systems (Deadlock, Query, Blocking) follow an identical lifecycle pattern that the MCP server must respect:

1. **Deploy** — creates the XE session; must be called once before pull/analysis tools work
2. **PullFromRingBuffer** — idempotent extraction; safe to call repeatedly; auto-restarts the session based on `MinutesBetweenRestart` from the corresponding `*LogStatus` table
3. **Analysis** — reads from permanent tables populated by pull; works even if the XE session is stopped
4. **Status** — returns current session state; use to check if monitoring is active before calling pull/analysis
5. **Destroy** — stops and drops the session; does not delete historical data

The MCP server should check the `Status` column in the relevant `*LogStatus` table (single-character: `R` = running, `S` = stopped) before surfacing analysis results, and warn the client if the session is not running.

### Blocking Alert Monitor (DMV-Based)

`cdre.BlockingAlertMonitor` is distinct from the XE-based `BlockingMonitor`. It is a DMV-polling procedure (not XE) that:
- Runs every 1–2 minutes via the `DBA - Blocking Session Alert` SQL Agent job
- Detects blocking chains in databases listed in `cdre.BlockingAlertConfig` with `ConfigType = 'WatchDatabase'`
- Persists events to `cdre.BlockingAlertEvent` and snapshots to `cdre.BlockingAlertSnapshot`
- Sends a single start alert and a single end alert per blocking event (no repeat emails)
- Uses `cdre.NotificationTargets` for email recipients grouped by `NotificationName`

The MCP tools `blocking_alert_active`, `blocking_alert_history`, and `blocking_alert_detail` read from these tables. `blocking_alert_detail` requires `@EventId UNIQUEIDENTIFIER` — obtain this from the `EventId` column returned by `blocking_alert_history` or `blocking_alert_active`.

### Third-Party Schema Constraints

**`BrentOzar.*` and `Minion.*` procedures must never be modified.** The MCP server may call them directly (they are wired via `ExecuteProcedureAsync`), but any behavioral customization must go through:
- `BrentOzar.Config_Blitz_SkipChecks` — suppress specific Blitz check IDs
- `Minion.IndexMaintSettingsServer`, `Minion.IndexSettingsDB`, `Minion.IndexSettingsTable` — Minion configuration tables

Do not add new MCP tools that call `BrentOzar.*` or `Minion.*` procedures with inline SQL — wrap them in a `cdre.*` procedure first if custom logic is needed.

### SaaS / Central Polling Considerations

In the SaaS architecture, the Worker Service (Quartz.NET) connects to client servers using one of three `IServerConnector` modes: `ThinAgent` (default), `DirectADO`, or `LinkedServer`. The MCP server itself always connects to the **Central Logging DB**, not directly to client servers. The `ServerId` column present on all central data/status/config tables must be included in queries when filtering to a specific client. Edition-adaptive collection (full XE vs. DMV fallback vs. Azure SQL DB-specific) is handled by the Worker Service, not the MCP server.

### Behavioral Notes for Implementers

- **`@WhatIf` parameter** — some maintenance procedures support `@WhatIf = 1` to preview actions without executing them. Expose this as an optional parameter on destructive tool calls.
- **`cdre.ResolveWaitResource`** — system/IAM/GAM pages return a descriptive error row (not a SQL exception) when `DBCC PAGE` output lacks `Metadata: ObjectId`. The MCP tool should treat a non-empty result set as success even if the resolved object name is NULL.
- **`cdre.JobStepHistory`** — falls back from `JOBHISTORY_ALL` (Azure Managed Instance view) to `msdb.dbo.sysjobhistory` automatically. No special handling needed in the MCP layer.
- **`ConfigTools.RunCustomQuery`** — executes user-supplied SQL by design and is a permanent exception to the `ExecuteProcedureAsync` rule. Do not use it as a pattern for new tools.
- **Timezone views** — `cdre.DeadLockLogDetails_CST` and `cdre.DeadLockLogStatus_CST` (and their `DeadLocks*` variants) convert `datetimeoffset` columns to Central Standard Time. Use these views for display when the client is in the Central timezone; use the base tables for UTC-normalized comparisons.
- **Index maintenance config cascade** — the effective threshold for any index is resolved Server → Database → Schema → Table → Index, with NULL meaning "inherit from parent." The `cdre.IndexMaint_Config` procedure resolves and displays the effective values; use it to validate configuration before running maintenance.
