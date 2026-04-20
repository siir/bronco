import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { PrismaClient } from '@bronco/db';
import { AIRouter } from '@bronco/ai-provider';
import { TaskType, SufficiencyStatus, SufficiencyConfidence } from '@bronco/shared-types';
import type { AIToolDefinition, AIToolUseBlock } from '@bronco/shared-types';
import { AppLogger, createLogger, decrypt, looksEncrypted, callMcpToolViaSdk } from '@bronco/shared-utils';

const logger = createLogger('ticket-analyzer');

// ---------------------------------------------------------------------------
// Sufficiency evaluation parsing
// ---------------------------------------------------------------------------

export const SUFFICIENCY_DELIMITER = '---SUFFICIENCY---';

export interface SufficiencyEvaluation {
  status: SufficiencyStatus;
  questions: string[];
  confidence: SufficiencyConfidence;
  reason: string;
}

export const VALID_SUFFICIENCY_STATUSES = new Set<string>(Object.values(SufficiencyStatus));
export const VALID_SUFFICIENCY_CONFIDENCES = new Set<string>(Object.values(SufficiencyConfidence));

/**
 * Parse the structured sufficiency suffix from an analysis response.
 * Returns the clean analysis text (without the suffix) and the parsed evaluation.
 * If no suffix is found, defaults to SUFFICIENT to avoid blocking tickets.
 */
export function parseSufficiencyEvaluation(rawAnalysis: string): { analysis: string; evaluation: SufficiencyEvaluation } {
  const delimIdx = rawAnalysis.lastIndexOf(SUFFICIENCY_DELIMITER);
  if (delimIdx === -1) {
    return {
      analysis: rawAnalysis,
      evaluation: { status: SufficiencyStatus.SUFFICIENT, questions: [], confidence: SufficiencyConfidence.MEDIUM, reason: 'No sufficiency evaluation provided — defaulting to SUFFICIENT' },
    };
  }

  const analysis = rawAnalysis.slice(0, delimIdx).trimEnd();
  const suffBlock = rawAnalysis.slice(delimIdx + SUFFICIENCY_DELIMITER.length).trim();

  let status: SufficiencyStatus = SufficiencyStatus.SUFFICIENT;
  let confidence: SufficiencyConfidence = SufficiencyConfidence.MEDIUM;
  let reason = '';
  const questions: string[] = [];

  let inQuestions = false;
  for (const line of suffBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('STATUS:')) {
      const val = trimmed.slice('STATUS:'.length).trim();
      if (VALID_SUFFICIENCY_STATUSES.has(val)) status = val as SufficiencyStatus;
      inQuestions = false;
    } else if (trimmed.startsWith('CONFIDENCE:')) {
      const val = trimmed.slice('CONFIDENCE:'.length).trim();
      if (VALID_SUFFICIENCY_CONFIDENCES.has(val)) confidence = val as SufficiencyConfidence;
      inQuestions = false;
    } else if (trimmed.startsWith('REASON:')) {
      reason = trimmed.slice('REASON:'.length).trim();
      inQuestions = false;
    } else if (trimmed.startsWith('QUESTIONS:')) {
      const inline = trimmed.slice('QUESTIONS:'.length).trim();
      if (inline) questions.push(inline);
      inQuestions = true;
    } else if (inQuestions && (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+[.)]/.test(trimmed))) {
      questions.push(trimmed.replace(/^[-*]\s*|^\d+[.)]\s*/, ''));
    }
  }

  return { analysis, evaluation: { status, questions, confidence, reason } };
}

/** Instructions appended to the agentic analysis system prompt for sufficiency evaluation. */
export const SUFFICIENCY_EVAL_INSTRUCTIONS = [
  '',
  '## Sufficiency Evaluation',
  '',
  'Before providing your final analysis, evaluate whether you have enough information to propose a resolution plan.',
  'Consider: Do you understand the root cause? Do you have enough evidence? Are there gaps only the user can fill?',
  '',
  'After your analysis, include a structured suffix on new lines:',
  '',
  '```',
  '---SUFFICIENCY---',
  'STATUS: SUFFICIENT | NEEDS_USER_INPUT | INSUFFICIENT',
  'QUESTIONS: [only if NEEDS_USER_INPUT — specific questions for the user, one per line starting with -]',
  'CONFIDENCE: HIGH | MEDIUM | LOW',
  'REASON: [brief explanation of why this status was chosen]',
  '```',
  '',
  'Guidelines:',
  '- SUFFICIENT: You have enough context from system sources to propose a concrete resolution plan.',
  '- NEEDS_USER_INPUT: You have exhausted system sources (databases, code repos) but have specific questions only the user can answer. Ask targeted questions — not vague "can you tell me more?"',
  '- INSUFFICIENT: You cannot determine what is needed — the ticket may be too vague or the systems are inaccessible. Flag for operator review.',
  '- Always provide your best analysis regardless of sufficiency status.',
].join('\n');

// ---------------------------------------------------------------------------
// Tool-result truncation scaffold
// ---------------------------------------------------------------------------

/**
 * Read the `analysis-tool-result-max-tokens` AppSetting. Returns the clamped
 * threshold in tokens. Default 4000 when unset; clamped to [500, 32000].
 */
export async function getToolResultMaxTokens(db: PrismaClient): Promise<number> {
  const setting = await db.appSetting.findUnique({ where: { key: 'analysis-tool-result-max-tokens' } });
  const value = setting?.value as { maxTokens?: unknown } | null;
  const raw = value?.maxTokens;
  let threshold = 4000;
  if (raw !== undefined && raw !== null) {
    const coerced = Number(raw);
    if (Number.isFinite(coerced)) {
      threshold = Math.min(32000, Math.max(500, Math.trunc(coerced)));
    }
  }
  return threshold;
}

/**
 * Cheap token-count heuristic: ~4 chars per token. Accurate enough for a
 * truncation gate — precise counting is not required.
 *
 * Returns false for content under 2000 chars regardless of threshold (preview
 * would be larger than original).
 */
export function shouldTruncate(content: string, thresholdTokens: number): boolean {
  if (content.length < 2000) return false;
  return Math.ceil(content.length / 4) >= thresholdTokens;
}

/**
 * Build a head+tail preview of an oversized tool result with an artifact
 * reference. Format is exact — the agent identifies truncation by the header
 * line and the `artifactId:` marker.
 */
export function buildTruncatedPreview(content: string, artifactId: string): string {
  const head = content.slice(0, 1500);
  const tail = content.slice(-500);
  return [
    '[truncated — full output saved as artifact]',
    `artifactId: ${artifactId}`,
    `size: ${content.length} chars`,
    '---',
    head,
    '',
    '...',
    '',
    tail,
  ].join('\n');
}

/**
 * System-prompt snippet advising the agent on how to recognize and paginate
 * truncated tool results. Exported for #301/#302 to append to their system
 * prompts — not wired in this session.
 */
export const TRUNCATION_SYSTEM_PROMPT_SNIPPET = [
  '',
  'Some tool results may be truncated to control token usage. Truncated results',
  'include a header line "[truncated — full output saved as artifact]" followed',
  'by an `artifactId:` value. If the truncated preview is insufficient for your',
  'analysis, call `platform__read_tool_result_artifact(artifactId, ...)` to fetch',
  'more — supply `offset` + `limit` to page through, or `grep` to search for',
  'specific patterns.',
].join('\n');

// ---------------------------------------------------------------------------
// Agentic tool builder / executor
// ---------------------------------------------------------------------------

export interface McpIntegrationInfo {
  label: string;
  url: string;
  mcpPath?: string;
  apiKey?: string;
  authHeader?: string;
}

/**
 * Build Claude tool definitions from a client's active MCP_DATABASE integrations
 * and code repositories (via mcp-repo). MCP tool names are prefixed with the
 * integration label to disambiguate across servers (e.g. `prod-db__get_blocking_tree`).
 */
export async function buildAgenticTools(
  db: PrismaClient,
  clientId: string,
  encryptionKey: string,
  mcpRepoUrl: string,
  mcpPlatformUrl: string,
  apiKey?: string,
  mcpAuthToken?: string,
): Promise<{
  tools: AIToolDefinition[];
  mcpIntegrations: Map<string, McpIntegrationInfo>;
  repoIdByPrefix: Map<string, string>;
}> {
  const tools: AIToolDefinition[] = [];
  const mcpIntegrations = new Map<string, McpIntegrationInfo>();
  const repoIdByPrefix = new Map<string, string>();

  // Collect MCP_DATABASE integrations
  const integrations = await db.clientIntegration.findMany({
    where: { clientId, type: 'MCP_DATABASE', isActive: true },
  });

  for (const integ of integrations) {
    const cfg = integ.config as Record<string, unknown>;
    const meta = integ.metadata as Record<string, unknown> | null;
    const url = typeof cfg['url'] === 'string' ? cfg['url'] : '';
    if (!url) continue;

    // Decrypt API key if present
    let integApiKey: string | undefined;
    if (typeof cfg['apiKey'] === 'string' && cfg['apiKey']) {
      try {
        integApiKey = looksEncrypted(cfg['apiKey'])
          ? decrypt(cfg['apiKey'], encryptionKey)
          : cfg['apiKey'];
      } catch (err) {
        logger.warn({ err, integrationId: integ.id }, 'Failed to decrypt MCP API key, skipping integration');
        continue;
      }
    }

    const authHeader = typeof cfg['authHeader'] === 'string' ? cfg['authHeader'] : 'bearer';
    const labelSlug = integ.label.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const prefix = `${labelSlug}-${integ.id.slice(0, 8)}`;

    const mcpPath = typeof cfg['mcpPath'] === 'string' ? cfg['mcpPath'] : undefined;
    mcpIntegrations.set(prefix, { label: integ.label, url, mcpPath, apiKey: integApiKey, authHeader });

    // Read tool metadata — includes inputSchema from discovery
    const disabledTools = new Set(
      Array.isArray(cfg['disabledTools']) ? (cfg['disabledTools'] as string[]) : [],
    );
    const discoveredTools = Array.isArray(meta?.['tools']) ? meta['tools'] as Array<Record<string, unknown>> : [];
    for (const t of discoveredTools) {
      const name = typeof t['name'] === 'string' ? t['name'] : '';
      if (!name || disabledTools.has(name)) continue;
      const description = typeof t['description'] === 'string' ? t['description'] : '';
      const inputSchema = (t['inputSchema'] as Record<string, unknown>) ?? { type: 'object', properties: {} };

      tools.push({
        name: `${prefix}__${name}`,
        description: `[${integ.label}] ${description}`,
        input_schema: inputSchema,
      });
    }
  }

  // Discover mcp-repo tools for client repositories
  const repos = await db.codeRepo.findMany({ where: { clientId, isActive: true } });
  if (repos.length > 0) {
    // Resolve auth for mcp-repo — prefer MCP_AUTH_TOKEN, fall back to API_KEY
    const repoAuth = mcpAuthToken || apiKey;
    const repoAuthHeader = mcpAuthToken ? 'bearer' : 'x-api-key';

    // Register shared mcp-repo integration for list_repos and repo_cleanup
    mcpIntegrations.set('repo', { label: 'mcp-repo', url: mcpRepoUrl, mcpPath: '/mcp', apiKey: repoAuth, authHeader: repoAuthHeader });

    tools.push({
      name: 'repo__list_repos',
      description: 'List available code repositories registered for this client.',
      input_schema: {
        type: 'object',
        properties: {
          clientId: { type: 'string', description: 'Client ID to filter by' },
        },
        required: ['clientId'],
      },
    });

    tools.push({
      name: 'repo__repo_cleanup',
      description: 'Release a session\'s repository worktrees to free disk space.',
      input_schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID to clean up' },
        },
        required: ['sessionId'],
      },
    });

    // Register per-repo repo_exec tools with repoId baked in
    for (const repo of repos) {
      const prefix = `repo-${repo.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}-${repo.id.slice(0, 8)}`;
      repoIdByPrefix.set(prefix, repo.id);

      // Register this prefix to point at mcp-repo
      mcpIntegrations.set(prefix, { label: `repo:${repo.name}`, url: mcpRepoUrl, mcpPath: '/mcp', apiKey: repoAuth, authHeader: repoAuthHeader });

      // Build a modified input schema for repo_exec with repoId removed
      tools.push({
        name: `${prefix}__repo_exec`,
        description: `[${repo.name}] ${repo.description || 'Code repository'}. Execute a read-only shell command in a sandboxed worktree. Allowed: grep, find, cat, head, tail, ls, tree, diff, stat. Pipes to grep/sed/awk/sort allowed.`,
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            sessionId: { type: 'string', description: 'Session ID for worktree reuse (auto-generated if omitted)' },
          },
          required: ['command'],
        },
      });
    }
  }

  // Register platform MCP server for read_tool_result_artifact
  const platformAuth = mcpAuthToken || apiKey;
  const platformAuthHeader = mcpAuthToken ? 'bearer' : 'x-api-key';
  mcpIntegrations.set('platform', {
    label: 'mcp-platform',
    url: mcpPlatformUrl,
    mcpPath: '/mcp',
    apiKey: platformAuth,
    authHeader: platformAuthHeader,
  });

  tools.push({
    name: 'platform__read_tool_result_artifact',
    description: 'Read a truncated tool-result artifact referenced by artifactId. Use when a prior tool result was truncated and you need to inspect more of it. Supports paging (offset + limit) and grep (regex search).',
    input_schema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'The artifact ID from a prior truncated tool result' },
        offset: { type: 'number', description: 'Character offset to start reading from (default 0)' },
        limit: { type: 'number', description: 'Max chars to return (default 4000, max 16000)' },
        grep: { type: 'string', description: 'Regex pattern to search for. When provided, offset/limit are ignored.' },
      },
      required: ['artifactId'],
    },
  });

  return { tools, mcpIntegrations, repoIdByPrefix };
}

/**
 * Execute a single tool call from the agentic loop.
 * Returns the tool result text and whether it was an error.
 */
export async function executeAgenticToolCall(
  toolCall: AIToolUseBlock,
  mcpIntegrations: Map<string, McpIntegrationInfo>,
  repoIdByPrefix: Map<string, string>,
  clientId?: string,
  ticketId?: string,
): Promise<{ toolUseId: string; result: string; isError: boolean }> {
  const { id: toolUseId, name, input } = toolCall;

  try {
    // MCP tool — parse prefix
    const sepIndex = name.indexOf('__');
    if (sepIndex === -1) {
      return { toolUseId, result: `Unknown tool: ${name}`, isError: true };
    }
    const prefix = name.slice(0, sepIndex);
    const actualToolName = name.slice(sepIndex + 2);
    const integration = mcpIntegrations.get(prefix);
    if (!integration) {
      return { toolUseId, result: `No MCP integration found for prefix "${prefix}"`, isError: true };
    }

    // For repo_exec, inject the baked-in repoId and clientId for defense-in-depth
    // For list_repos, inject clientId to prevent cross-client repo enumeration
    // For read_tool_result_artifact, inject ticketId as the auth scope (overwrite any agent-supplied value)
    let toolInput = input;
    if (actualToolName === 'repo_exec') {
      const repoId = repoIdByPrefix.get(prefix);
      if (repoId) {
        toolInput = { ...input, repoId, ...(clientId ? { clientId } : {}) };
      }
    } else if (actualToolName === 'list_repos' && clientId) {
      toolInput = { ...input, clientId };
    } else if (actualToolName === 'read_tool_result_artifact' && ticketId) {
      toolInput = { ...input, ticketId };
    }

    const result = await callMcpToolViaSdk(
      integration.url,
      integration.mcpPath,
      actualToolName,
      toolInput,
      integration.apiKey,
      integration.authHeader,
    );
    return { toolUseId, result, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolUseId, result: `Tool error: ${msg}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Orchestrated analysis helpers
// ---------------------------------------------------------------------------

export const ORCHESTRATED_SYSTEM_PROMPT = `You are an expert DBA and systems analyst conducting a structured investigation.

You will investigate the issue step by step. On each iteration you receive:
- The ticket context and any client-specific knowledge (first iteration only)
- A "knowledge document" summarizing everything learned so far
- A prompt directing what to investigate next

Return a JSON object in a markdown code block with:
{
  "findings": "Markdown text summarizing what you've learned or concluded in this iteration",
  "tasks": [
    {
      "prompt": "A focused prompt for a sub-task",
      "tools": ["tool_name_1", "tool_name_2"],
      "model": "haiku|sonnet|opus"
    }
  ],
  "nextPrompt": "What should be investigated in the next iteration after these tasks complete",
  "done": false
}

Guidelines for task assignment:
- Use "haiku" for simple data gathering (fetching events, listing indexes, getting health stats)
- Use "sonnet" for moderate analysis (pattern recognition, correlation checking)
- Use "opus" for complex reasoning (root cause analysis, architecture decisions)
- Keep tasks focused — each task should have a clear, specific goal
- Maximum 5 tasks per iteration

CRITICAL: In the "tools" array, use EXACT tool names from the Available Tools list provided in the prompt. Do not abbreviate, rename, or invent tool names. Copy-paste the full tool name including any prefix (e.g. "ap-dbadmin-e5834180__run_query", not "run_query" or "run_sql_query"). If no available tool fits the task, leave the tools array empty and describe what data you need in the prompt text so the model can request it conversationally.

When you have enough information to provide a final analysis, set "done": true and include:
{
  "findings": "Final summary",
  "tasks": [],
  "nextPrompt": null,
  "done": true,
  "finalAnalysis": "Full detailed markdown analysis with root cause, evidence, recommendations..."
}

Include sufficiency evaluation in your final analysis using the ---SUFFICIENCY--- format.

Prior analysis runs (if any) may be summarized or referenced for historical context. Focus your investigation on the current run. Reference prior findings if relevant but don't repeat work already done.

Note: Full raw tool results from prior iterations are stored by the orchestrator but may not be included directly in this prompt. If you need to review specific historical or raw data, explicitly request it in a task prompt so it can be provided.`;

export interface StrategistPlan {
  findings: string;
  tasks: Array<{ prompt: string; tools: string[]; model: string }>;
  nextPrompt: string | null;
  done: boolean;
  finalAnalysis?: string;
  parseError?: string;
}

export function parseStrategistResponse(content: string): StrategistPlan {
  // Try to extract JSON from markdown code blocks first, then raw JSON
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : content.trim();

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      findings: typeof parsed['findings'] === 'string' ? parsed['findings'] : '',
      tasks: Array.isArray(parsed['tasks'])
        ? (parsed['tasks'] as Array<Record<string, unknown>>).map(t => ({
            prompt: typeof t['prompt'] === 'string' ? t['prompt'] : '',
            tools: Array.isArray(t['tools']) ? (t['tools'] as string[]) : [],
            model: typeof t['model'] === 'string' ? t['model'] : 'sonnet',
          }))
        : [],
      nextPrompt: typeof parsed['nextPrompt'] === 'string' ? parsed['nextPrompt'] : null,
      done: parsed['done'] === true,
      finalAnalysis: typeof parsed['finalAnalysis'] === 'string' ? parsed['finalAnalysis'] : undefined,
    };
  } catch (error) {
    logger.warn(
      { err: error, contentPreview: content.slice(0, 500) },
      'Failed to parse strategist JSON response; treating raw content as final analysis to avoid wasting iterations',
    );
    // Treat unparseable responses as done to avoid burning tokens on a retry loop.
    // The raw content is surfaced as the final analysis so no work is lost.
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      findings: content,
      tasks: [],
      nextPrompt: null,
      done: true,
      finalAnalysis: content,
      parseError: errMsg,
    };
  }
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const normalizedSize = Number.isFinite(size) ? Math.floor(size) : NaN;
  if (!Number.isFinite(normalizedSize) || normalizedSize <= 0) {
    throw new Error(`chunkArray size must be a positive integer, got: ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += normalizedSize) {
    chunks.push(arr.slice(i, i + normalizedSize));
  }
  return chunks;
}

export interface SubTaskResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }>;
}

/** Resolve the orchestrated model map from active Claude provider models.
 *  Maps short names (haiku/sonnet/opus) to the actual model IDs configured in the DB. */
export async function resolveOrchestratedModelMap(db: PrismaClient): Promise<Record<string, string>> {
  const models = await db.aiProviderModel.findMany({
    where: { isActive: true, provider: { provider: 'CLAUDE' } },
    select: { model: true },
    orderBy: [{ model: 'asc' }],
  });
  const matches: Record<'haiku' | 'sonnet' | 'opus', string[]> = {
    haiku: [],
    sonnet: [],
    opus: [],
  };
  for (const { model } of models) {
    const lower = model.toLowerCase();
    if (lower.includes('haiku')) matches.haiku.push(model);
    else if (lower.includes('sonnet')) matches.sonnet.push(model);
    else if (lower.includes('opus')) matches.opus.push(model);
  }
  const map: Record<string, string> = {};
  for (const shortName of ['haiku', 'sonnet', 'opus'] as const) {
    const candidates = matches[shortName];
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      logger.warn(
        { shortName, candidates },
        'Multiple active Claude models matched orchestrated short name; using first from deterministic ordering',
      );
    }
    map[shortName] = candidates[0];
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tool resolution: exact → base-name → substring → fuzzy
// ---------------------------------------------------------------------------

export interface ToolResolution {
  resolved: AIToolDefinition[];
  fuzzy: Map<string, Array<{ tool: AIToolDefinition; score: number }>>;
  unmatched: string[];
}

export function resolveTaskTools(
  requestedNames: string[],
  availableTools: AIToolDefinition[],
): ToolResolution {
  const resolved: AIToolDefinition[] = [];
  const fuzzy = new Map<string, Array<{ tool: AIToolDefinition; score: number }>>();
  const unmatched: string[] = [];
  const resolvedSet = new Set<string>();

  // Normalize: trim whitespace and drop empty strings to prevent spurious substring matches
  const normalizedNames = requestedNames.map(n => n.trim()).filter(n => n.length > 0);

  for (const requested of normalizedNames) {
    // 1. Exact match
    const exact = availableTools.find(t => t.name === requested);
    if (exact) {
      if (!resolvedSet.has(exact.name)) {
        resolved.push(exact);
        resolvedSet.add(exact.name);
      }
      continue;
    }

    // 2. Base name exact (strip prefix before __) — only accept if unambiguous
    const baseNameMatches = availableTools.filter(
      t => (t.name.split('__').pop() ?? t.name) === requested,
    );
    if (baseNameMatches.length === 1) {
      const [baseName] = baseNameMatches;
      if (!resolvedSet.has(baseName.name)) {
        resolved.push(baseName);
        resolvedSet.add(baseName.name);
      }
      continue;
    }
    if (baseNameMatches.length > 1) {
      // Ambiguous base name — surface as fuzzy candidates rather than auto-selecting
      fuzzy.set(requested, baseNameMatches.slice(0, 3).map(tool => ({ tool, score: 1 })));
      continue;
    }

    // 3. Substring match on base name only — only accept if unambiguous
    const substringMatches = availableTools.filter(
      t => (t.name.split('__').pop() ?? t.name).includes(requested),
    );
    if (substringMatches.length === 1) {
      const [substring] = substringMatches;
      if (!resolvedSet.has(substring.name)) {
        resolved.push(substring);
        resolvedSet.add(substring.name);
      }
      continue;
    }
    if (substringMatches.length > 1) {
      // Ambiguous substring — fall through to fuzzy scoring
    }

    // 4. Fuzzy scoring
    const requestedWords = new Set(requested.toLowerCase().split(/[_-]/));
    const candidates: Array<{ tool: AIToolDefinition; score: number }> = [];

    for (const tool of availableTools) {
      const toolBase = (tool.name.split('__').pop() ?? tool.name).toLowerCase();
      const toolWords = new Set(toolBase.split(/[_-]/));

      // Jaccard similarity
      const intersection = new Set([...requestedWords].filter(w => toolWords.has(w)));
      const union = new Set([...requestedWords, ...toolWords]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 0;

      // Description match
      const descLower = (tool.description ?? '').toLowerCase();
      const reqWordArr = [...requestedWords];
      const descMatches = reqWordArr.filter(w => descLower.includes(w)).length;
      const descScore = reqWordArr.length > 0 ? descMatches / reqWordArr.length : 0;

      const score = jaccard * 0.7 + descScore * 0.3;
      if (score >= 0.3) {
        candidates.push({ tool, score });
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      fuzzy.set(requested, candidates.slice(0, 3));
    } else {
      unmatched.push(requested);
    }
  }

  return { resolved, fuzzy, unmatched };
}

/**
 * Sanitize a string to be safe for use as a filename component.
 * Only allows alphanumerics, dots, hyphens, and underscores; replaces all
 * other characters (including path separators) with underscores and trims
 * to 64 characters to prevent path traversal or excessively long filenames.
 */
export function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

export async function saveMcpToolArtifact(
  db: PrismaClient,
  ticketId: string,
  toolName: string,
  rawResult: string,
  storagePath: string,
  artifactId?: string,
): Promise<void> {
  try {
    let isJson = false;
    try { JSON.parse(rawResult); isJson = true; } catch { /* not JSON */ }
    const mimeType = isJson ? 'application/json' : 'text/plain';
    const ext = isJson ? 'json' : 'txt';
    const safeToolName = sanitizeFilenameSegment(toolName || 'unknown');
    const filename = `mcp-${safeToolName}-${Date.now()}-${randomUUID()}.${ext}`;
    const resolvedStorage = resolve(storagePath);
    const ticketDir = resolve(resolvedStorage, 'tickets', ticketId);
    const rel = relative(resolvedStorage, ticketDir);
    if (rel.startsWith('..') || rel === '') {
      logger.warn({ ticketId, ticketDir, resolvedStorage }, 'MCP artifact path escaped storage root — skipping');
      return;
    }
    const fullPath = join(ticketDir, filename);
    await mkdir(ticketDir, { recursive: true });
    await writeFile(fullPath, rawResult, 'utf-8');
    const relativePath = `tickets/${ticketId}/${filename}`;
    await db.artifact.create({
      data: {
        ...(artifactId ? { id: artifactId } : {}),
        ticketId,
        filename,
        mimeType,
        sizeBytes: Buffer.byteLength(rawResult, 'utf-8'),
        storagePath: relativePath,
        description: `Raw MCP tool output from agentic analysis (${toolName})`,
      },
    });
    logger.info({ ticketId, filename }, 'MCP tool artifact saved');
  } catch (err) {
    logger.warn({ err, ticketId }, 'Failed to save MCP tool artifact — continuing');
  }
}

// Signals indicating a sub-task result may be irrelevant (checked in first 500 chars)
export const IRRELEVANT_SIGNALS = [
  'not relevant', 'unable to', 'cannot access', 'i cannot', "i don't have",
  'wrong tool', 'unexpected result', 'does not apply', 'no data returned',
  'tool returned an error',
];

// ---------------------------------------------------------------------------
// Strategy resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective analysis strategy for an AGENTIC_ANALYSIS step.
 * Step-level `analysisStrategy` config takes priority over the global AppSetting.
 * Legacy `'full_context'` and anything other than `'orchestrated'` map to `'flat'`.
 */
export async function resolveAnalysisStrategy(
  db: PrismaClient,
  step: { config: unknown },
): Promise<'flat' | 'orchestrated'> {
  const strategySetting = await db.appSetting.findUnique({ where: { key: 'system-config-analysis-strategy' } });
  const strategyConfig = strategySetting?.value as { strategy?: string; maxParallelTasks?: number } | null;
  const stepConfig = step.config as { analysisStrategy?: string } | null;
  const raw = stepConfig?.analysisStrategy ?? strategyConfig?.strategy ?? 'full_context';
  return raw === 'orchestrated' ? 'orchestrated' : 'flat';
}

/**
 * Resolve `maxParallelTasks` from the analysis-strategy AppSetting.
 * Clamped to [1, 10]; defaults to 3 when unset or invalid.
 */
export async function resolveMaxParallelTasks(db: PrismaClient): Promise<number> {
  const strategySetting = await db.appSetting.findUnique({ where: { key: 'system-config-analysis-strategy' } });
  const strategyConfig = strategySetting?.value as { strategy?: string; maxParallelTasks?: number } | null;
  const raw = strategyConfig?.maxParallelTasks;
  let maxParallelTasks = 3;
  if (raw !== undefined && raw !== null) {
    const coerced = Number(raw);
    if (Number.isFinite(coerced)) {
      maxParallelTasks = Math.min(10, Math.max(1, Math.trunc(coerced)));
    }
  }
  return maxParallelTasks;
}

// ---------------------------------------------------------------------------
// Dependency bag and pipeline context shared between strategies
// ---------------------------------------------------------------------------

export interface AnalysisDeps {
  db: PrismaClient;
  ai: AIRouter;
  appLog: AppLogger;
  encryptionKey: string;
  mcpRepoUrl: string;
  mcpPlatformUrl: string;
  apiKey?: string;
  mcpAuthToken?: string;
  artifactStoragePath?: string;
  loadDefaultMaxTokens?: () => Promise<number | undefined>;
}

export interface AnalysisPipelineContext {
  ticketId: string;
  clientId: string;
  category: string;
  priority: string;
  emailSubject: string;
  emailBody: string;
  clientContext: string;
  environmentContext: string;
  codeContext: string[];
  dbContext: string;
  facts: {
    errorMessages?: string[];
    filesMentioned?: string[];
    servicesMentioned?: string[];
    databaseRelated?: boolean;
    keywords?: string[];
  };
  summary: string;
  sufficiencyEval?: SufficiencyEvaluation;
}

export interface AnalysisResult {
  analysis: string;
  toolCallLog: Array<{ tool: string; system?: string; input: Record<string, unknown>; output: string; durationMs: number }>;
  totalInputTokens: number;
  totalOutputTokens: number;
  iterationsRun: number;
  sufficiencyEval: SufficiencyEvaluation;
}

/** Context passed to the pipeline during re-analysis (reply-triggered). */
export interface ReanalysisContext {
  /** Formatted markdown conversation history from all prior events. */
  conversationHistory: string;
  /** The raw reply text that triggered this re-analysis. */
  triggerReplyText: string;
  /** The ticket event ID that triggered this re-analysis (for metadata tracking). */
  triggerEventId?: string;
}

export interface StrategyStep {
  config: unknown;
  taskTypeOverride?: string | null;
}

// Re-export TaskType for strategy modules
export { TaskType };
