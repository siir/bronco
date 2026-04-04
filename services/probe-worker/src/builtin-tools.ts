import type { PrismaClient } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import { TaskType, SELF_CLIENT_ID, SystemAnalysisTriggerType } from '@bronco/shared-types';
import { createLogger, callMcpToolViaSdk, decrypt, looksEncrypted } from '@bronco/shared-utils';

const logger = createLogger('probe-worker:builtin-tools');

/** Maximum output length to stay within AI prompt limits. */
const MAX_OUTPUT_CHARS = 8000;

export interface BuiltinToolDeps {
  db: PrismaClient;
  ai?: AIRouter;
  mcpRepoUrl?: string;
  encryptionKey?: string;
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
  analyze_app_health: executeAppHealthAnalysis,
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

// ---------------------------------------------------------------------------
// analyze_app_health implementation
// ---------------------------------------------------------------------------

async function executeAppHealthAnalysis(
  params: Record<string, unknown>,
  deps: BuiltinToolDeps,
): Promise<string> {
  const { db, ai, mcpRepoUrl } = deps;

  if (!ai) {
    return 'Error: AI router not available — cannot run app health analysis.';
  }

  const lookbackDays = typeof params['lookbackDays'] === 'number' ? Math.max(1, Math.min(90, params['lookbackDays'])) : 7;
  const repoUrl = typeof params['repoUrl'] === 'string' ? params['repoUrl'] : undefined;
  const paramMcpRepoUrl = typeof params['mcpRepoUrl'] === 'string' ? params['mcpRepoUrl'] : undefined;
  const effectiveMcpRepoUrl = paramMcpRepoUrl || mcpRepoUrl;

  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  logger.info({ lookbackDays, repoUrl }, 'Executing analyze_app_health');

  // 1. Gather ticket stats
  const [ticketsByCategory, ticketsByStatus, ticketCount] = await Promise.all([
    db.ticket.groupBy({
      by: ['category'],
      where: { createdAt: { gte: cutoff } },
      _count: true,
    }),
    db.ticket.groupBy({
      by: ['status'],
      where: { createdAt: { gte: cutoff } },
      _count: true,
    }),
    db.ticket.count({ where: { createdAt: { gte: cutoff } } }),
  ]);

  const ticketStats =
    `Total tickets (last ${lookbackDays}d): ${ticketCount}\n` +
    `By category: ${ticketsByCategory.map((g) => `${g.category}: ${g._count}`).join(', ') || 'none'}\n` +
    `By status: ${ticketsByStatus.map((g) => `${g.status}: ${g._count}`).join(', ') || 'none'}`;

  // 2. Gather AI usage trends
  const aiUsage = await db.aiUsageLog.groupBy({
    by: ['taskType'],
    where: { createdAt: { gte: cutoff } },
    _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    _count: true,
  });

  const aiUsageSummary = aiUsage.length > 0
    ? aiUsage.map((g: { taskType: string; _count: number; _sum: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } }) =>
      `${g.taskType}: ${g._count} calls, ${(g._sum.inputTokens ?? 0) + (g._sum.outputTokens ?? 0)} tokens, $${(g._sum.costUsd ?? 0).toFixed(4)}`,
    ).join('\n')
    : 'No AI usage in this period.';

  // 3. Gather error summary via executeLogScan
  const errorReport = await executeLogScan(
    { hours: lookbackDays * 24, minLevel: 'ERROR' },
    deps,
  );

  // 4. Fetch open GitHub issues (if configured)
  let issuesSummary = 'GitHub not configured — skipping open issues.';
  try {
    const ghSetting = await db.appSetting.findUnique({ where: { key: 'system-config-github' } });
    const ghConfig = ghSetting?.value as Record<string, unknown> | undefined;
    const ghTokenRaw = typeof ghConfig?.['token'] === 'string' ? ghConfig['token'] : undefined;
    const ghRepo = typeof ghConfig?.['repo'] === 'string' ? ghConfig['repo'] : undefined;

    if (ghTokenRaw && ghRepo) {
      // The token may be AES-256-GCM encrypted in the DB — decrypt if needed
      const ghToken = (deps.encryptionKey && looksEncrypted(ghTokenRaw))
        ? decrypt(ghTokenRaw, deps.encryptionKey)
        : ghTokenRaw;
      const res = await fetch(`https://api.github.com/repos/${ghRepo}/issues?state=open&per_page=50`, {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (res.ok) {
        const issues = (await res.json()) as Array<{ number: number; title: string }>;
        issuesSummary = issues.length > 0
          ? issues.map((i) => `#${i.number}: ${i.title}`).join('\n')
          : 'No open issues.';
      } else {
        issuesSummary = `GitHub API returned ${res.status} — skipping.`;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch GitHub issues for app health analysis');
    issuesSummary = 'Failed to fetch GitHub issues.';
  }

  // 5. Gather code context via mcp-repo (optional)
  let codeContext = '';
  if (effectiveMcpRepoUrl && repoUrl) {
    try {
      const searchResult = await callMcpToolViaSdk(
        effectiveMcpRepoUrl,
        undefined,
        'search_code',
        { repo_url: repoUrl, query: 'TaskType prompt definition route step', max_results: 20 },
      );
      codeContext = `## Code Search Results\n${searchResult.slice(0, 4000)}`;
    } catch (err) {
      logger.warn({ err }, 'Failed to search code via mcp-repo');
      codeContext = '(Code search unavailable)';
    }
  }

  // 6. Call AI
  const userPrompt =
    `## Ticket Statistics (last ${lookbackDays} days)\n${ticketStats}\n\n` +
    `## AI Usage Trends\n${aiUsageSummary}\n\n` +
    `## Error Log Summary\n${errorReport.slice(0, 4000)}\n\n` +
    `## Open GitHub Issues\n${issuesSummary}\n\n` +
    (codeContext ? `${codeContext}\n\n` : '');

  const response = await ai.generate({
    taskType: TaskType.ANALYZE_APP_HEALTH,
    prompt: userPrompt,
    promptKey: 'system-analysis.app-health.system',
    context: { entityType: 'system' },
  });

  // 7. Parse and store
  const content = response.content;
  const suggestionsIdx = content.indexOf('## Suggestions');
  const analysisIdx = content.indexOf('## Analysis');

  let analysis: string;
  let suggestions: string;

  if (analysisIdx !== -1 && suggestionsIdx !== -1) {
    const analysisStart = analysisIdx + '## Analysis'.length;
    const suggestionsStart = suggestionsIdx + '## Suggestions'.length;
    if (analysisIdx < suggestionsIdx) {
      analysis = content.substring(analysisStart, suggestionsIdx).trim();
      suggestions = content.substring(suggestionsStart).trim();
    } else {
      suggestions = content.substring(suggestionsStart, analysisIdx).trim();
      analysis = content.substring(analysisStart).trim();
    }
  } else if (analysisIdx !== -1) {
    analysis = content.substring(analysisIdx + '## Analysis'.length).trim();
    suggestions = '';
  } else {
    analysis = content.trim();
    suggestions = '';
  }

  await db.systemAnalysis.create({
    data: {
      clientId: SELF_CLIENT_ID,
      ticketId: null,
      triggerType: SystemAnalysisTriggerType.SCHEDULED,
      analysis,
      suggestions,
      aiModel: response.model,
      aiProvider: response.provider,
    },
  });

  const suggestionLines = suggestions.split('\n').filter((l) => l.trim().length > 0);
  const topSuggestion = suggestionLines[0] ?? 'No suggestions.';

  return `Created system analysis with ${suggestionLines.length} suggestion(s). Top suggestion: ${topSuggestion.slice(0, 200)}`;
}
