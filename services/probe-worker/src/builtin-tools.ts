import type { PrismaClient } from '@bronco/db';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('probe-worker:builtin-tools');

/** Maximum output length to stay within AI prompt limits. */
const MAX_OUTPUT_CHARS = 8000;

export interface BuiltinToolDeps {
  db: PrismaClient;
}

/**
 * Registry of built-in probe tools that execute locally instead of calling an
 * MCP server. Each handler receives the tool params (from `probe.toolParams`)
 * and dependencies, and returns a formatted text report.
 */
export const BUILTIN_TOOLS: Record<
  string,
  (params: Record<string, unknown>, deps: BuiltinToolDeps) => Promise<string>
> = {
  scan_app_logs: executeLogScan,
};

// ---------------------------------------------------------------------------
// scan_app_logs implementation
// ---------------------------------------------------------------------------

interface LogGroup {
  service: string;
  level: string;
  message: string;
  count: number;
  firstOccurrence: Date;
  lastOccurrence: Date;
  errorStack: string | null;
  context: unknown;
}

async function executeLogScan(
  params: Record<string, unknown>,
  deps: BuiltinToolDeps,
): Promise<string> {
  const rawHours = typeof params['hours'] === 'number' ? params['hours'] : 6;
  const hours = Math.max(1, Math.min(168, Math.round(rawHours)));
  const servicesParam = typeof params['services'] === 'string' ? params['services'] : 'all';
  const minLevel = typeof params['minLevel'] === 'string' ? params['minLevel'].toUpperCase() : 'ERROR';
  const excludePatterns = typeof params['excludePatterns'] === 'string'
    ? params['excludePatterns'].split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Determine which levels to include
  const levels: string[] = minLevel === 'WARN' ? ['ERROR', 'WARN'] : ['ERROR'];

  // Build the where clause
  const where: Record<string, unknown> = {
    createdAt: { gte: cutoff },
    level: { in: levels },
  };

  if (servicesParam !== 'all') {
    const serviceList = servicesParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (serviceList.length > 0) {
      where['service'] = { in: serviceList };
    }
  }

  logger.info({ hours, services: servicesParam, minLevel, excludePatterns }, 'Executing scan_app_logs');

  const LOG_QUERY_LIMIT = 5000;
  const logs = await deps.db.appLog.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: LOG_QUERY_LIMIT + 1,
    select: {
      level: true,
      service: true,
      message: true,
      context: true,
      error: true,
      createdAt: true,
    },
  });

  if (logs.length === 0) {
    return `No errors found in the last ${hours} hours.`;
  }

  const queryTruncated = logs.length > LOG_QUERY_LIMIT;
  const resultLogs = queryTruncated ? logs.slice(0, LOG_QUERY_LIMIT) : logs;

  // Group by service + message (deduplicate repeated identical errors)
  const groups = new Map<string, LogGroup>();
  for (const log of resultLogs) {
    // Apply exclude patterns
    const msg = log.message ?? '';
    const errorStr = log.error ?? '';
    const contextStr = typeof log.context === 'object' ? JSON.stringify(log.context) : String(log.context ?? '');
    const combined = `${msg} ${errorStr} ${contextStr}`;
    if (excludePatterns.some((pat) => combined.includes(pat))) continue;

    const key = `${log.service}::${log.level}::${msg}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (log.createdAt < existing.firstOccurrence) existing.firstOccurrence = log.createdAt;
      if (log.createdAt > existing.lastOccurrence) existing.lastOccurrence = log.createdAt;
      // Keep the most recent stack trace
      if (log.error) existing.errorStack = log.error;
      if (log.context) existing.context = log.context;
    } else {
      groups.set(key, {
        service: log.service ?? 'unknown',
        level: log.level,
        message: msg,
        count: 1,
        firstOccurrence: log.createdAt,
        lastOccurrence: log.createdAt,
        errorStack: log.error ?? null,
        context: log.context,
      });
    }
  }

  if (groups.size === 0) {
    return `No errors found in the last ${hours} hours (all matched entries were excluded by patterns).`;
  }

  // Organize by service
  const byService = new Map<string, LogGroup[]>();
  for (const group of groups.values()) {
    const existing = byService.get(group.service);
    if (existing) {
      existing.push(group);
    } else {
      byService.set(group.service, [group]);
    }
  }

  // Build report
  const lines: string[] = [];
  lines.push(`## Application Log Scan — Last ${hours} hours\n`);

  let totalUnique = 0;
  let totalOccurrences = 0;
  const servicesAffected = byService.size;
  let mostFrequent: { message: string; count: number } = { message: '', count: 0 };

  for (const [service, serviceGroups] of byService) {
    // Sort by count descending
    serviceGroups.sort((a, b) => b.count - a.count);

    const errorCount = serviceGroups.length;
    lines.push(`### ${service} (${errorCount} unique error${errorCount !== 1 ? 's' : ''})\n`);

    for (const g of serviceGroups) {
      totalUnique += 1;
      totalOccurrences += g.count;
      if (g.count > mostFrequent.count) {
        mostFrequent = { message: g.message, count: g.count };
      }

      const timeStr =
        g.count === 1
          ? g.firstOccurrence.toISOString()
          : `first: ${g.firstOccurrence.toISOString()}, last: ${g.lastOccurrence.toISOString()}`;
      lines.push(`**[${g.level}] ${g.message}** (x${g.count}, ${timeStr})`);

      if (g.context && typeof g.context === 'object') {
        const ctxStr = JSON.stringify(g.context);
        if (ctxStr.length > 2) {
          lines.push(`Context: ${ctxStr.slice(0, 300)}`);
        }
      }

      if (g.errorStack) {
        lines.push(`Stack: ${g.errorStack.slice(0, 500)}`);
      }

      lines.push('');
    }
  }

  // Summary
  lines.push('### Summary');
  lines.push(`- Total errors: ${totalUnique} unique (${totalOccurrences} occurrences)`);
  lines.push(`- Services affected: ${servicesAffected}`);
  if (mostFrequent.message) {
    lines.push(`- Most frequent: "${mostFrequent.message}" (${mostFrequent.count}x)`);
  }
  if (queryTruncated) {
    lines.push(`- **Note:** Results limited to ${LOG_QUERY_LIMIT} rows — additional log entries exist but are not shown`);
  }

  let report = lines.join('\n');
  if (report.length > MAX_OUTPUT_CHARS) {
    report = report.slice(0, MAX_OUTPUT_CHARS - 50) + '\n\n... (output truncated)';
  }

  return report;
}
