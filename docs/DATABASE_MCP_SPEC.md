<!-- MCP_SPEC_META
version: 2026-04-28T16:05:31Z
source_commit: 570ac5a13d0d6be9842ac73a906505a8375a2137
generator: ai
proc_count: 110
mcp_proc_count: 15
table_count: 52
func_count: 9
view_count: 7
job_count: 6
trigger_count: 1
-->
# SQL-DBAdmin MCP Server Specification

> **Auto-generated** — use this document to build or update an MCP server that exposes this SQL Server DBA toolkit's capabilities as tools and resources.


## MCP Tools to Expose

### Blocking

#### `blocking_sessions`
- **Procedure**: `cdre.BlockingSessions`
- **Parameters**: None
- **Description**: Real-time DMV snapshot of all active blocking chains with cycle detection. Uses a recursive CTE against `sys.dm_exec_requests` and `sys.dm_exec_sessions` to identify head blockers, blocked sessions, wait types, elapsed time, and SQL text. Use for immediate blocking investigation — no parameters, no history required.

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
- **Description**: Extract blocking events from the ring buffer, parse XML blocked process reports, and persist to `cdre.BlockingLogDetails`. Captures full blocker and blocked session context including SQL text, login, host, application, database, isolation level, and wait resource. Auto-restarts the XE session based on `MinutesBetweenRestart` from `cdre.BlockingMonitorLogStatus`. Updates `LastPull` and `LastBlockingEvent` timestamps. Scheduled every 5 minutes via the `DBA - Blocking Monitor Pull` SQL Agent job.

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

#### `blocking_alert_monitor`
- **Procedure**: `cdre.BlockingAlertMonitor`
- **Parameters**: None
- **Description**: DMV-based blocking alert monitor. Polls active sessions to detect blocking chains in databases listed in `cdre.BlockingAlertConfig` with `ConfigType = 'WatchDatabase'`. Persists events to `cdre.BlockingAlertEvent` and snapshots to `cdre.BlockingAlertSnapshot`. Sends a single start alert and a single end alert per blocking event via `cdre.NotificationTargets`. Normally invoked by the `DBA - Blocking Session Alert` SQL Agent job every 2 minutes — call this tool manually only for testing or on-demand checks.

#### `blocking_monitor_analysis`
- **Procedure**: `cdre.BlockingMonitorAnalysis`
- **Parameters**: None (report type varies by procedure implementation — summary, topblockers, topresources, timeline)
- **Description**: Generate blocking trend reports from persisted data in `cdre.BlockingLogDetails`. Report modes include summary, top blockers, top wait resources, and timeline views. Works from historical data — does not require the XE session to be running. Use after `blocking_monitor_pull` has populated the log table.

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
- **Description**: Extract deadlock events from the ring buffer, parse XML deadlock graphs, and persist to `cdre.DeadlocksLogDetails`. Idempotent — deduplicates on `(DeadlockTime, SessionId)`. Auto-restarts the session based on `MinutesBetweenRestart` from `cdre.DeadLocksLogStatus`. Updates `LastPull` and `LastDeadLock` timestamps. Schedule every 5–15 minutes via SQL Agent.

#### `deadlocks_analysis`
- **Procedure**: `cdre.DeadlocksAnalysis`
- **Parameters**: None (report type and date range vary by procedure implementation)
- **Description**: Generate deadlock trend reports from persisted data in `cdre.DeadlocksLogDetails`. Summarizes deadlock frequency, affected databases, victim sessions, wait resources, and involved SQL statements. Works from historical data — does not require the XE session to be running. Use after `deadlock_pull` has populated the log table.

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
- **Description**: Extract query events from the ring buffer, apply INCLUDE/EXCLUDE filters from `cdre.QueryMonitorConfig`, and persist to `cdre.QueryMonitorLogDetails`. Aggregates execution statistics per query hash. Auto-restarts the session based on `MinutesBetweenRestart`. Updates `LastPull`, `LastQueryCaptured`, and `TotalQueriesTracked`. Scheduled every 10 minutes via the `DBA - Query Monitor Pull` SQL Agent job.

#### `query_monitor_analysis`
- **Procedure**: `cdre.QueryMonitorAnalysis`
- **Parameters**: None (report type and filters vary by procedure implementation)
- **Description**: Generate query performance reports from persisted data in `cdre.QueryMonitorLogDetails`. Surfaces top queries by total duration, CPU, logical reads, and execution count. Works from historical data — does not require the XE session to be running. Use after `query_monitor_pull` has populated the log table.

#### `plan_cache_search`
- **Procedure**: `cdre.PlanCacheSearch`
- **Parameters**:
  - `@DatabaseName SYSNAME` — Target database to search (required)
  - `@SearchText NVARCHAR(MAX)` — Substring to search for in cached query text (required)
- **Description**: Search the live plan cache for queries referencing a substring in a target database. Queries `sys.dm_exec_cached_plans` and `sys.dm_exec_sql_text`. Apply a 90-second command timeout in the MCP layer — plan cache scans can be expensive on busy servers. Use to identify which cached plans reference a specific table, procedure, or text pattern.

#### `plan_cache_top_consumers`
- **Procedure**: `cdre.PlanCacheTopConsumers`
- **Parameters**:
  - `@DatabaseName SYSNAME` — Target database to analyze (required)
  - `@OrderBy NVARCHAR(20) = 'cpu'` — Sort metric: `cpu`, `logical_reads`, `duration`, or `executions`
- **Description**: Return the top resource-consuming plans from the live plan cache for a target database. Queries `sys.dm_exec_cached_plans`, `sys.dm_exec_query_stats`, and `sys.dm_exec_sql_text`. Use to identify the most expensive queries currently in cache without requiring the query monitor XE session to be running.

#### `query_store_search`
- **Procedure**: `cdre.QueryStoreSearch`
- **Parameters**:
  - `@DatabaseName SYSNAME` — Target database to search (required); Query Store must be in `READ_WRITE` mode or the procedure raises an error
  - `@SearchText NVARCHAR(MAX)` — Substring to search for in Query Store query text (required)
- **Description**: Search Query Store across a target database. Weights results by `avg_duration_ms` and `avg_logical_reads` multiplied by `count_executions`. Raises an error if Query Store is not in `READ_WRITE` mode on the target database. Use to find historical query performance data for a specific query pattern without relying on the live plan cache.

#### `query_executor_now`
- **Procedure**: `cdre.QueryExecutorNow`
- **Parameters**:
  - `@DatabaseName SYSNAME` — Target database to filter sessions by (required)
- **Description**: Live snapshot of sessions currently running against a target database with full executor identity: login name, host name, program name, and client network address. Queries `sys.dm_exec_requests`, `sys.dm_exec_sessions`, and `sys.dm_exec_sql_text`. Use during an active incident to identify who is running what against a specific database right now.

---

### User Statements

#### `user_statements_deploy`
- **Procedure**: `cdre.CapturedUserStatementsDeploy`
- **Parameters**: None
- **Description**: Create and start the `Capture_UserStatements_RB` Extended Event session (captures `sqlserver.sql_statement_completed` with ring buffer target). Initializes `cdre.CapturedUserStatementsStatus`. Part of the three-stage XE monitoring pattern: Deploy → PullFromBuffer → analysis.

#### `user_statements_destroy`
- **Procedure**: `cdre.CaptureUserStatementsDestroy`
- **Parameters**: None
- **Description**: Stop and drop the user statement capture XE session. Preserves historical data in `cdre.CapturedUserStatements`.

#### `user_statements_pull`
- **Procedure**: `cdre.CapturedUserStatementsPullFromBuffer`
- **Parameters**: None
- **Description**: Extract user statements from the ring buffer, apply include/exclude filters from `cdre.CapturedUserStatementsConfig`, and persist to `cdre.CapturedUserStatements`. Uses deduplication on `(EventTimeUtc, SessionId, EventName, SqlHash)`. Enforces `RetentionDays` from `cdre.CapturedUserStatementsStatus`.

---

### Index Maintenance

#### `index_analysis`
- **Procedure**: `cdre.IndexAnalysis`
- **Parameters**:
  - `@DatabaseName SYSNAME = NULL` — Database to analyze (required for `unused` report; NULL = all databases for `missing`)
  - `@Report NVARCHAR(20) = 'missing'` — Report type: `missing`, `unused`, or `all`
- **Description**: Analyze missing and unused indexes using DMV data. The `missing` report uses `sys.dm_db_missing_index_details`; the `unused` report uses `sys.dm_db_index_usage_stats`. `@DatabaseName` is required for the `unused` report.

#### `index_maint`
- **Procedure**: `cdre.IndexMaint`
- **Parameters**: None (configuration is table-driven via `cdre.IndexMaintConfig_*`)
- **Description**: Execute the custom index maintenance orchestrator. Reads fragmentation thresholds from the `cdre.IndexMaintConfig_Database`, `cdre.IndexMaintConfig_Schema`, `cdre.IndexMaintConfig_Table`, and `cdre.IndexMaintConfig_Index` cascade. Logs results to `cdre.IndexMaintHistory`, `cdre.IndexMaintHistoryDatabases`, and `cdre.IndexMaintHistoryDetails`. Use a long or unlimited command timeout — this procedure can run for hours on large environments.

---

### Jobs

#### `job_step_history`
- **Procedure**: `cdre.JobStepHistory`
- **Parameters**:
  - `@JobName NVARCHAR(128)` — Job name (required)
  - `@Runs INT = 10` — Number of recent runs to return
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Return per-step execution history for a SQL Agent job. Uses `JOBHISTORY_ALL` view if available (Azure Managed Instance), otherwise falls back to `msdb.dbo.sysjobhistory`. Shows step name, status, duration, and message for each step of each run.

#### `job_runtime_anomaly_detection`
- **Procedure**: `cdre.JobRuntimeAnomaly_Detection`
- **Parameters**:
  - `@Debug BIT = 0` — Show detailed debug output
  - `@Help BIT = 0` — Display help information
- **Description**: Detect currently running SQL Agent jobs that exceed baseline thresholds. Compares running jobs against baselines stored in `cdre.JobRuntimeBaseline` using `RuntimeThresholdMultiplier` (default 3×), `MinimumRuntimeMinutes`, and `MaximumRuntimeMinutes` from `cdre.JobRuntimeAnomalyConfig`. Prerequisite: baselines must be calculated first via the `DBA - Job Runtime Baseline Update` job. If `cdre.JobRuntimeBaseline` is empty, the procedure returns no results rather than an error. Scheduled every 15 minutes via the `DBA - Job Runtime Anomaly Detection` job.

#### `job_runtime_baseline_update`
- **Procedure**: `cdre.JobRuntimeBaseline_Update`
- **Parameters**:
  - `@Debug BIT = 0` — Debug mode
- **Description**: Calculate and store runtime baselines (median, average, percentiles, standard deviation) for all SQL Agent jobs based on historical execution data from `msdb`. Uses outlier detection (IQR or other method per `cdre.JobRuntimeAnomalyConfig`) to exclude abnormal runs. Results are upserted into `cdre.JobRuntimeBaseline` — one row per `job_id`. Normally run daily at 1:00 AM by the `DBA - Job Runtime Baseline Update` SQL Agent job; call manually to force a refresh after significant job schedule changes.

---

### Maintenance

#### `maintenance_dbcc_checkdb`
- **Procedure**: `cdre.Maintenance_DBCCCheckDB`
- **Parameters**: None (database exclusions configured via `cdre.SettingsDB`)
- **Description**: Run `DBCC CHECKDB` across all non-excluded databases. Logs results to `cdre.MaintenanceResults`. Use `cdre.SettingsDB` with `ExecName = 'CheckDB'` to exclude specific databases. Use a long or unlimited command timeout — this procedure can run for hours on large databases.

#### `maintenance_update_all_stats`
- **Procedure**: `cdre.Maintenance_UpdateAllStats`
- **Parameters**: None (database exclusions configured via `cdre.SettingsDB`)
- **Description**: Update statistics across all non-excluded databases. Logs results to `cdre.MaintenanceResults`. Use `cdre.SettingsDB` with `ExecName = 'UpdateStats'` to exclude specific databases. Use a long or unlimited command timeout.

---

### System Health

#### `resolve_wait_resource`
- **Procedure**: `cdre.ResolveWaitResource`
- **Parameters**:
  - `@WaitResource NVARCHAR(256)` — Wait resource string to resolve (required); e.g., `KEY: 5:72057594038321152 (8194443284a0)`, `PAGE: 5:1:12345`, `RID: 5:1:12345:0`
  - `@Debug BIT = 0` — Debug mode
  - `@Help BIT = 0` — Display help information
- **Description**: Resolve a SQL Server wait resource string to a human-readable object name (database, schema, table, index). Handles KEY, PAGE, RID, and OBJECT lock types. Uses `DBCC PAGE` for page-level resolution. System/IAM/GAM pages return a descriptive error row rather than raising an exception. For KEY locks, resolves via `sys.dm_tran_locks` `hobt_id` — a live lock must exist at call time for KEY resolution to succeed.

---

### Configuration

#### `config_blocking_alert`
- **Procedure**: `cdre.Config_BlockingAlert` *(or direct table read)*
- **Parameters**: None
- **Description**: Display current blocking alert configuration from `cdre.BlockingAlertConfig`, showing all rules by `ConfigType` (`ThresholdSeconds`, `RetentionDays`, `NotificationName`, `WatchDatabase`, `ExcludeLogin`, `ExcludeProgram`) with their `MatchType` and `IsEnabled` state. Use to verify which databases are being watched and which logins or programs are excluded before investigating a blocking alert.

#### `config_notification_targets`
- **Procedure**: `cdre.Config_NotificationTargets` *(or direct table read)*
- **Parameters**: None
- **Description**: Display current email notification targets from `cdre.NotificationTargets`, grouped by `NotificationName`. Shows which email addresses receive alerts for each named notification group and which Database Mail profile is used.

---

### DevOps

#### `schema_change_log`
- **Procedure**: wrapping `cdre.*` procedure reading `dev.SchemaChanges`
- **Parameters**: None
- **Description**: Return recent schema change events captured by the `dev_trg_LogSchemaChanges` DDL trigger from `dev.SchemaChangeLog`. Includes event type, database, schema, object name, object type, login, program name, T-SQL command executed, and before/after object definitions. The `dev.SchemaChanges` view adds `ObjectDefinitionBefore` by joining each version to its predecessor. Useful for auditing recent deployments or tracking unintended schema changes.

---

### Development

#### `dev_script_table_create`
- **Procedure**: wrapping `cdre.*` procedure calling `dev.fn_ScriptTableCreate`
- **Parameters**:
  - `@ObjectId INT` — The `object_id` of the table to script (required); obtain from `sys.objects` or `OBJECT_ID()`
- **Description**: Generate a `CREATE TABLE` DDL script for a table by its `object_id`. Uses the `dev.fn_ScriptTableCreate` scalar function internally. Useful for quickly capturing the current schema of a table during an investigation or before making structural changes.

#### `dev_schema_changes_recent`
- **Procedure**: wrapping `cdre.*` procedure reading `dev.SchemaChanges`
- **Parameters**: None
- **Description**: Return the most recent schema change events from the `dev.SchemaChanges` view, which layers before/after object definitions on top of `dev.SchemaChangeLog`. Includes triggering login, program name, event type, and the full T-SQL command. Use to audit what changed and who changed it after a deployment or incident.

## MCP Resources to Expose

These are data sources the MCP server should expose as resources. Unless otherwise noted, resources are **read-only** (monitoring data, logs, results). Configuration tables are the exception — they should be exposed as **read/write** resources so that MCP clients can perform configuration updates (INSERT/UPDATE/DELETE) without requiring raw SQL access.

---

### Blocking Alert Configuration

#### `resource://cdre/blocking-alert-config`
- **Table**: `cdre.BlockingAlertConfig`
- **Access**: Read/Write
- **Description**: Controls the `cdre.BlockingAlertMonitor` DMV-based blocking alert system. Each row is a typed rule. Operators add rows to define which databases to watch, which logins/programs to exclude, and what threshold to apply. The `MatchType` column supports exact or `LIKE`-style matching. The `ConfigType` column determines the rule's role in the system. `MatchType` is constrained to `'Exact'` or `'Like'` by a check constraint — validate client-side before insert/update.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `ConfigId` | `INT IDENTITY` | No | — | Surrogate primary key |
| `ConfigType` | `NVARCHAR(50)` | No | — | Rule type: `ThresholdSeconds`, `RetentionDays`, `NotificationName`, `WatchDatabase`, `ExcludeLogin`, `ExcludeProgram` |
| `Value` | `NVARCHAR(512)` | No | — | The value for the rule (e.g., database name, login name, seconds) |
| `MatchType` | `NVARCHAR(10)` | No | `'Exact'` | `Exact` or `Like` — controls whether `Value` is matched literally or with `LIKE`; constrained to these two values by a check constraint |
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
- **Description**: INCLUDE/EXCLUDE filter rules applied when `cdre.QueryMonitorPullFromRingBuffer` processes ring buffer events. Rows with `FilterType = 'INCLUDE'` restrict capture to matching sessions; rows with `FilterType = 'EXCLUDE'` suppress matching sessions. NULL columns act as wildcards. `FilterType` is constrained to `'INCLUDE'` or `'EXCLUDE'` by a check constraint — validate client-side before insert/update.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Id` | `INT IDENTITY` | No | — | Surrogate primary key |
| `LoginName` | `NVARCHAR(128)` | Yes | NULL | Login name to match (NULL = any login) |
| `DatabaseName` | `NVARCHAR(128)` | Yes | NULL | Database name to match (NULL = any database) |
| `AppNameFilter` | `NVARCHAR(256)` | Yes | NULL | Application name to match (NULL = any application) |
| `TextFilter` | `NVARCHAR(500)` | Yes | NULL | SQL text substring to match (NULL = any text) |
| `FilterType` | `VARCHAR(10)` | No | `'INCLUDE'` | `INCLUDE` or `EXCLUDE` — direction of the filter; constrained to these two values |
| `IsActive` | `BIT` | No | `1` | Whether this filter rule is currently applied |
| `CreatedDate` | `DATETIMEOFFSET` | No | `SYSUTCDATETIME()` | When the rule was created |
| `ModifiedDate` | `DATETIMEOFFSET` | Yes | NULL | When the rule was last modified |

---

### Blocking Monitor Status

#### `resource://cdre/blocking-monitor-status`
- **Table**: `cdre.BlockingMonitorLogStatus`
- **Access**: Read-only
- **Description**: Single-row state table for the `BlockingMonitor` Extended Event session. Used by `cdre.BlockingMonitorPullFromRingBuffer` to track session health, auto-restart timing, and last activity. Query this to determine whether the XE session is running and when it last captured data.

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
- **Description**: Database-level index maintenance thresholds. Settings here override server defaults and are inherited by all schemas, tables, and indexes in the named database unless overridden at a lower level. Set `Ignore = 1` to skip an entire database. NULL threshold values mean "inherit from server default."

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `Database` | `SYSNAME` | No | — | Database name this configuration applies to |
| `Ignore` | `BIT` | Yes | `0` | Skip this database entirely during index maintenance |
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % at or above which REORGANIZE is performed (NULL = inherit from server default) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % at or above which REBUILD is performed (NULL = inherit from server default) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count required before maintenance is considered (NULL = inherit from server default) |

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
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REORGANIZE (NULL = inherit from database level) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REBUILD (NULL = inherit from database level) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count threshold (NULL = inherit from database level) |

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
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REORGANIZE (NULL = inherit from schema level) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REBUILD (NULL = inherit from schema level) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count threshold (NULL = inherit from schema level) |

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
| `Reorg_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REORGANIZE (NULL = inherit from table level) |
| `Fragmentation_Threshold` | `FLOAT` | Yes | NULL | Fragmentation % threshold for REBUILD (NULL = inherit from table level) |
| `PageCount_Threshold` | `INT` | Yes | NULL | Minimum page count threshold (NULL = inherit from table level) |

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
| `OutlierMethod` | `VARCHAR(20)` | No | `'IQR'` | Outlier detection method (e.g., `IQR`) |
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
- **Description**: Calculated baseline statistics for each SQL Agent job, updated daily by the `DBA - Job Runtime Baseline Update` job. One row per `job_id` (unique constraint). Used by `cdre.JobRuntimeAnomaly_Detection` to compare currently running jobs against historical norms. If this table is empty, anomaly detection will return no results — run the baseline update job first.

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
- **Description**: Suppresses specific `sp_Blitz` health check findings. Add a row to permanently silence a check for a given server/database combination. NULL in `ServerName` or `DatabaseName` acts as a wildcard. **Do not modify the `BrentOzar` schema objects themselves** — this table is the approved configuration interface for the First Responder Kit.

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
- **Description**: Controls which databases are excluded from specific maintenance operations (DBCC CheckDB, statistics updates, etc.). Each row associates a database name with a named operation via `ExecName`. Set `Exclude = 1` to skip the database for that operation.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `ExecName` | `NVARCHAR(256)` | Yes | NULL | Operation name that reads this exclusion list (e.g., `CheckDB`, `UpdateStats`) |
| `DatabaseName` | `NVARCHAR(128)` | Yes | NULL | Database to exclude from the named operation |
| `Exclude` | `BIT` | Yes | `1` | Whether to exclude this database (1 = exclude) |

---

### Schema Change Log Configuration

#### `resource://dev/schema-change-log-config`
- **Table**: `dev.SchemaChangeLogConfig`
- **Access**: Read/Write
- **Description**: Controls the behavior of the `dev_trg_LogSchemaChanges` DDL trigger. Each row is a typed key/value setting. The `LOGGING_ENABLED` key acts as a global on/off switch for schema change capture. Additional rows can define include/exclude filters for databases, object types, or logins.

| Column | Type | Nullable | Default | Purpose |
|--------|------|----------|---------|---------|
| `LogID` | `INT IDENTITY` | No | — | Surrogate primary key |
| `Type` | `VARCHAR(20)` | No | — | Setting category (e.g., `LOGGING_ENABLED`, `EXCLUDE_LOGIN`, `EXCLUDE_DB`) |
| `Key` | `VARCHAR(128)` | No | — | Setting key within the category |
| `Value` | `VARCHAR(256)` | No | — | Setting value |
| `Enabled` | `BIT` | No | `1` | Whether this configuration row is active |

## MCP Server Implementation Notes

### Connection Configuration

The MCP server connects to a single **administrative database** (conventionally named `DBAdmin`) on a SQL Server 2016+ instance or Azure Managed Instance. All `cdre.*`, `dbo.*`, `dev.*`, `devops.*`, and `jobs.*` objects reside in this one database. The connection string must be configured as an environment variable or application setting — there is no runtime database selection for the primary admin connection.

**Required connection string settings:**
- `Database` / `Initial Catalog`: The admin database name (e.g., `DBAdmin`)
- `Server`: SQL Server instance name or Azure Managed Instance FQDN
- Authentication: SQL Server Authentication or Windows Authentication (Integrated Security)
- `MultipleActiveResultSets=True` — several procedures return multiple result sets
- `Connect Timeout`: Recommend ≥ 30 seconds; some maintenance procedures run long
- `Command Timeout`: Set per-tool — use a short timeout (30–60 seconds) for status and query tools, and a long or unlimited timeout (`0`) for maintenance operations such as `cdre.IndexMaint`, `cdre.Maintenance_DBCCCheckDB`, and `cdre.Maintenance_UpdateAllStats`

**Secondary connections (cross-database tools):**
- `DataSyncTools.GetDataSyncQueueStatus` uses a dynamic database name sourced from an environment variable — this is a known legacy exception tracked in `TODO.md` and uses `ExecuteQueryAsync` rather than `ExecuteProcedureAsync`
- `EvolutionErrorLogTools.*` queries a separate application database — also a tracked legacy exception
- All other tools connect exclusively to the admin database

### Authentication and Authorization

The SQL login used by the MCP server requires:
- `EXECUTE` permission on all `cdre.*`, `dbo.*`, `dev.*`, `devops.*`, and `jobs.*` procedures
- `SELECT` on all `cdre.*`, `BrentOzar.*`, `Minion.*`, `dev.*`, and `dbo.*` tables and views
- `VIEW SERVER STATE` — required by blocking, query monitor, and activity monitor tools that query DMVs (`sys.dm_exec_requests`, `sys.dm_exec_sessions`, `sys.dm_tran_locks`, `sys.dm_db_missing_index_details`, etc.)
- `VIEW DATABASE STATE` — required for XE ring buffer access and `sys.dm_db_index_physical_stats`
- `ALTER SETTINGS` — required by `cdre.BlockingMonitorDeploy` (sets `blocked process threshold` via `sp_configure`)
- Access to `msdb` — required by job history procedures that query `msdb.dbo.sysjobs`, `msdb.dbo.sysjobhistory`, and related tables

For the SaaS/central-polling architecture, the Worker Service uses JWT bearer + API key dual authentication with reader/operator/admin RBAC tiers. Reader-tier tokens should be restricted from calling destructive procedures (`*Destroy`, `*Deploy`).

### Calling Convention

**All tool methods must call `SqlQueryHelper.ExecuteProcedureAsync`** — never `ExecuteQueryAsync` in tool files except for the three tracked legacy exceptions (`ConfigTools.RunCustomQuery`, `DataSyncTools.GetDataSyncQueueStatus`, and `EvolutionErrorLogTools.*`). These exceptions must not be expanded. Every tool maps 1:1 to a stored procedure. When adding a new tool, create the stored procedure first, then wire the C# to call it.

Procedure calls follow the pattern:
```
EXEC [cdre].[ProcedureName] @Param1 = @value1, @Param2 = @value2
```

Parameters with defaults do not need to be passed unless overriding the default. The `@Debug BIT = 0` and `@Help BIT = 0` parameters present on most `cdre.*` procedures should be exposed as optional tool parameters. `@Debug = 1` causes procedures to emit `RAISERROR ... WITH NOWAIT` progress messages and may return additional diagnostic result sets.

**Schema envelope pattern:** Tools that return structured data should call `ExecuteProcedureWithSchemaAsync` (not the bare `ExecuteProcedureAsync`) and pass a hand-written `SchemaDescriptor` describing the response shape. The helper wraps the result in `{ "_schema": ..., "data": ... }` so downstream consumers get tier-1 schema fidelity. When authoring a `SchemaDescriptor`:
- Read the actual stored procedure to get column names — do not guess. Schema keys must match the proc's `SELECT` aliases exactly (case included).
- Mark fields as `string|null`, `int|null`, etc. when the underlying column is nullable or the XE shred can produce NULLs.
- For multi-result-set procs, use `Kind: "json_object"` with `TopLevelKeys` and set `Partial: true`.
- XE lifecycle commands (`*_deploy` / `*_destroy` / `*_restart` / `*_pull`) return tiny status payloads and don't need the envelope.

### Error Handling Patterns

All `cdre.*` procedures use `TRY/CATCH` blocks internally. The MCP server should:

1. **Propagate SQL errors** — catch `SqlException` and surface the error message and severity to the MCP client. SQL Server severity ≥ 16 indicates a procedure-level error; severity 11–15 are warnings.
2. **Handle multiple result sets** — many analysis and status procedures return 2–5 result sets. The C# layer must read all result sets in order using `NextResultAsync()`. Stopping after the first result set will leave the connection in a dirty state.
3. **Handle empty result sets gracefully** — status procedures return empty sets when no data has been collected yet. This is not an error.
4. **Respect `RAISERROR WITH NOWAIT`** — progress messages from long-running procedures (index maintenance, DBCC) are emitted as informational messages (severity 0–10) via `SqlConnection.InfoMessage`. Wire up the `InfoMessage` event handler to stream these to the MCP client as progress notifications rather than discarding them.
5. **Timeout handling** — maintenance procedures (`cdre.IndexMaint`, `cdre.Maintenance_DBCCCheckDB`, `cdre.Maintenance_UpdateAllStats`) should use `CommandTimeout = 0` (unlimited). Status and query tools should use a bounded timeout (30–60 seconds). `cdre.PlanCacheSearch` uses a 90-second timeout in the MCP layer.

### Database Targeting: Admin DB vs. Target DBs

The toolkit uses a **central admin database model** — all procedures, tables, and configuration live in the single admin database. Procedures that need to inspect other databases do so internally via:

- **Dynamic SQL with `USE [database]`** — used by index maintenance, DBCC, statistics update, and invalid object detection procedures. The MCP server passes database names as parameters; the procedures handle cross-database execution internally.
- **`msdb` queries** — job history and related procedures query `msdb` directly. The SQL login must have appropriate `msdb` access.
- **`sys.databases` / DMV queries** — server-scope views are accessible from the admin database context with `VIEW SERVER STATE`.

The MCP server **never needs to switch its connection's database context** — all calls go to the admin database, and procedures handle any cross-database work internally.

### Extended Events Monitoring Architecture

The three XE monitoring systems (Deadlock, Query, Blocking) follow an identical lifecycle pattern that the MCP server must respect:

1. **Deploy** — creates the XE session; must be called once before pull/analysis tools work
2. **PullFromRingBuffer** — idempotent extraction; safe to call repeatedly; auto-restarts the session based on `MinutesBetweenRestart` from the corresponding `*LogStatus` table
3. **Analysis** — reads from permanent tables populated by pull; works even if the XE session is stopped
4. **Status** — returns current session state; use to check if monitoring is active before calling pull/analysis
5. **Destroy** — stops and drops the session; does not delete historical data

The MCP server should check the `Status` column in the relevant `*LogStatus` table (single-character: `R` = running, `S` = stopped) before surfacing analysis results, and warn the client if the session is not running.

A fourth monitoring system — User Statement Capture (`cdre.CapturedUserStatements*`) — follows the same Deploy → PullFromBuffer pattern. Its status is tracked in `cdre.CapturedUserStatementsStatus`.

The MCP-wired XE lifecycle procedures and their parameters are:

| Procedure | Key Parameters |
|-----------|---------------|
| `cdre.BlockingMonitorDeploy` | `@ThresholdSeconds INT = 15`, `@MinutesBetweenRestart INT = 480`, `@Debug BIT = 0` |
| `cdre.BlockingMonitorDestroy` | `@ResetThreshold BIT = 0`, `@Debug BIT = 0` |
| `cdre.BlockingMonitorPullFromRingBuffer` | `@Debug BIT = 0` |
| `cdre.BlockingMonitorRestart` | `@Debug BIT = 0` |
| `cdre.DeadlocksMonitorDeploy` | None |
| `cdre.DeadlocksMonitorDestroy` | None |
| `cdre.DeadlocksPullFromRingBuffer` | None |
| `cdre.DeadlocksRestart` | None |
| `cdre.QueryMonitorDeploy` | None |
| `cdre.QueryMonitorDestroy` | None |
| `cdre.QueryMonitorPullFromRingBuffer` | None |
| `cdre.QueryMonitorRestart` | None |
| `cdre.CapturedUserStatementsDeploy` | None |
| `cdre.CaptureUserStatementsDestroy` | None |
| `cdre.CapturedUserStatementsPullFromBuffer` | None |

### Blocking Alert Monitor (DMV-Based)

`cdre.BlockingAlertMonitor` is distinct from the XE-based `BlockingMonitor`. It is a DMV-polling procedure (not XE) that:
- Runs every 1–2 minutes via the `DBA - Blocking Session Alert` SQL Agent job
- Detects blocking chains in databases listed in `cdre.BlockingAlertConfig` with `ConfigType = 'WatchDatabase'`
- Persists events to `cdre.BlockingAlertEvent` and snapshots to `cdre.BlockingAlertSnapshot`
- Sends a single start alert and a single end alert per blocking event (no repeat emails for the same ongoing event)
- Uses `cdre.NotificationTargets` for email recipients grouped by `NotificationName`

The `blocking_alert_detail` tool requires `@EventId UNIQUEIDENTIFIER` — obtain this from the `EventId` column returned by `blocking_alert_history` or `blocking_alert_active`. The `cdre.BlockingAlertConfig` `MatchType` column is constrained to `'Exact'` or `'Like'` by a check constraint; validate this client-side before insert/update to avoid a constraint violation.

### Third-Party Schema Constraints

**`BrentOzar.*` and `Minion.*` procedures must never be modified.** The MCP server may call them directly via `ExecuteProcedureAsync`, but any behavioral customization must go through:
- `BrentOzar.Config_Blitz_SkipChecks` — suppress specific `sp_Blitz` check IDs
- `Minion.IndexMaintSettingsServer`, `Minion.IndexSettingsDB`, `Minion.IndexSettingsTable` — Minion configuration tables

Do not add new MCP tools that call `BrentOzar.*` or `Minion.*` procedures with inline SQL — wrap them in a `cdre.*` procedure first if custom logic is needed.

### SaaS / Central Polling Considerations

In the SaaS architecture, the Worker Service (Quartz.NET) connects to client servers using one of three `IServerConnector` modes: `ThinAgent` (default), `DirectADO`, or `LinkedServer`. The MCP server itself always connects to the **Central Logging DB**, not directly to client servers. The `ServerId` column present on all central data/status/config tables must be included in queries when filtering to a specific client. Edition-adaptive collection (full XE vs. DMV fallback vs. Azure SQL DB-specific) is handled by the Worker Service, not the MCP server.

### Behavioral Notes for Implementers

- **`@WhatIf` parameter** — some maintenance procedures support `@WhatIf = 1` to preview actions without executing them. Expose this as an optional parameter on destructive tool calls where the procedure supports it.
- **`cdre.ResolveWaitResource`** — system/IAM/GAM pages return a descriptive error row (not a SQL exception) when `DBCC PAGE` output lacks `Metadata: ObjectId`. The MCP tool should treat a non-empty result set as success even if the resolved object name is NULL. For KEY locks, the procedure resolves via `sys.dm_tran_locks` `hobt_id`; a live lock must exist at call time for resolution to succeed.
- **`cdre.JobStepHistory`** — falls back from `JOBHISTORY_ALL` (Azure Managed Instance view) to `msdb.dbo.sysjobhistory` automatically. No special handling needed in the MCP layer.
- **`ConfigTools.RunCustomQuery`** — executes user-supplied SQL by design and is a permanent exception to the `ExecuteProcedureAsync` rule. Do not use it as a pattern for new tools.
- **Timezone views** — `cdre.DeadLockLogDetails_CST`, `cdre.DeadLockLogStatus_CST`, `cdre.DeadLocksLogDetails_CST`, and `cdre.DeadLocksLogStatus_CST` convert `datetimeoffset` columns to Central Standard Time using `AT TIME ZONE`. Use these views for display when the client is in the Central timezone; use the base tables (`cdre.DeadlocksLogDetails`, `cdre.DeadLocksLogStatus`) for UTC-normalized comparisons. Note that two pairs of CST views exist with slightly different column sets — `cdre.DeadLocksLogDetails_CST` includes `ResolvedDatabaseName` aliased as `DatabaseName` and a `ResolvedResource` column; `cdre.DeadLockLogDetails_CST` (without the `s` in `Lock`) does not include those resolved columns.
- **Index maintenance config cascade** — the effective threshold for any index is resolved Server → Database → Schema → Table → Index, with NULL meaning "inherit from parent." Validate configuration at each level before running maintenance.
- **Job runtime anomaly prerequisites** — `cdre.JobRuntimeAnomaly_Detection` requires that baselines have been calculated first by the `DBA - Job Runtime Baseline Update` job (runs daily at 1:00 AM). If `cdre.JobRuntimeBaseline` is empty, the detection procedure will return no results rather than an error. Surface a warning to the MCP client in this case.
- **`cdre.QueryMonitorConfig` `FilterType`** — constrained to `'INCLUDE'` or `'EXCLUDE'` by a check constraint. Validate client-side before insert/update.
- **`cdre.BlockingAlertConfig` `MatchType`** — constrained to `'Exact'` or `'Like'` by a check constraint. Validate client-side before insert/update.
- **`cdre.QueryStoreSearch`** — raises an error if Query Store is not in `READ_WRITE` mode on the target database. The MCP tool should catch this and surface a clear message rather than a generic SQL error.
- **`cdre.PlanCacheSearch` and `cdre.PlanCacheTopConsumers`** — these tools scan `sys.dm_exec_cached_plans` and can be expensive on busy servers. Apply a 90-second command timeout for `cdre.PlanCacheSearch` in the MCP layer. Warn users that plan cache scans may cause brief performance impact on heavily loaded instances.
- **Deployment order dependency** — the toolkit must be deployed in the order: Schemas → Tables → Functions → Stored Procedures → SQL Agent Jobs → configuration table population. MCP tools that call procedures referencing configuration tables (e.g., `cdre.BlockingAlertMonitor`, `cdre.QueryMonitorPullFromRingBuffer`) will return empty or unexpected results if the corresponding configuration tables have not been populated after deployment. Migration scripts must use a `.txt` extension (not `.sql`) to prevent Red Gate SQL Source Control from treating them as database objects.
- **`cdre.CapturedUserStatements` computed column** — the `EventTimePST` column is a computed column that converts `EventTimeUtc` to Pacific Standard Time using `AT TIME ZONE`. Do not attempt to insert into this column; it is read-only.
- **Post-investigation tooling review** — after any debugging session using MCP tools, review every tool call and `run_custom_query` made and evaluate whether new stored procedures, MCP tools, or logging improvements should be proposed. Any reusable query run more than once is a candidate for a `cdre.*` procedure and corresponding MCP tool. Track gaps in `TODO.md`.
