import { PrismaClient } from '@bronco/db';
import { createLogger } from './logger.js';
import { decrypt, looksEncrypted } from './crypto.js';

const logger = createLogger('tool-request-github');

const SETTINGS_KEY_GITHUB = 'system-config-github';

export interface CreateGithubIssueInput {
  toolRequestId: string;
  repoOwner?: string;
  repoName?: string;
  labels?: string[];
  /**
   * Bypass the APPROVED-status and existing-issue guards. Intended for
   * explicit operator overrides (e.g., re-creating an issue after a repo
   * migration). Defaults to `false`.
   */
  force?: boolean;
}

/** Sentinel thrown when the tool request exists but is not eligible for issue creation. */
export class ToolRequestNotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestNotEligibleError';
  }
}

/** Sentinel thrown when the tool request row does not exist. */
export class ToolRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Tool request ${id} not found`);
    this.name = 'ToolRequestNotFoundError';
  }
}

export interface CreateGithubIssueResult {
  issueUrl: string;
  issueNumber: number;
}

interface RationaleRow {
  id: string;
  rationale: string;
  source: string;
  createdAt: Date;
  ticket: { id: string; ticketNumber: number; subject: string } | null;
}

interface ToolRequestRow {
  id: string;
  displayTitle: string;
  description: string;
  status: string;
  githubIssueUrl: string | null;
  requestCount: number;
  suggestedInputs: unknown;
  exampleUsage: string | null;
  rationales: RationaleRow[];
  client: { id: string; name: string; shortCode: string | null };
}

/**
 * Creates a GitHub issue from a ToolRequest row's content. Uses the
 * `system-config-github` AppSetting for both the PAT (encrypted) and the
 * default target repo (`repo` field, "owner/name" format). Per-call
 * `repoOwner` / `repoName` overrides take precedence.
 *
 * On success, persists `githubIssueUrl` and `implementedInIssue` on the row
 * so the admin UI can show the link without refetching.
 */
export async function createToolRequestGithubIssue(
  db: PrismaClient,
  encryptionKey: string,
  input: CreateGithubIssueInput,
): Promise<CreateGithubIssueResult> {
  const row = (await db.toolRequest.findUnique({
    where: { id: input.toolRequestId },
    include: {
      rationales: {
        orderBy: { createdAt: 'desc' },
        include: {
          ticket: { select: { id: true, ticketNumber: true, subject: true } },
        },
      },
      client: { select: { id: true, name: true, shortCode: true } },
    },
  })) as ToolRequestRow | null;
  if (!row) throw new ToolRequestNotFoundError(input.toolRequestId);

  // Idempotency guard — the admin UI only exposes Create GitHub Issue on
  // APPROVED rows with no existing issue. Enforce the same invariant here so
  // out-of-band callers (MCP, scripts) can't accidentally spam duplicate
  // issues. Operators can override with `force: true`.
  if (!input.force) {
    if (row.status !== 'APPROVED') {
      throw new ToolRequestNotEligibleError(
        `Tool request must be APPROVED to create a GitHub issue (current status: ${row.status}). Pass force=true to override.`,
      );
    }
    if (row.githubIssueUrl) {
      throw new ToolRequestNotEligibleError(
        `Tool request already has a GitHub issue (${row.githubIssueUrl}). Pass force=true to create another.`,
      );
    }
  }

  const githubRow = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_GITHUB } });
  if (!githubRow) {
    throw new Error('GitHub token not configured (system-config-github AppSetting missing)');
  }
  const cfg = githubRow.value as { token?: string; repo?: string } | null;
  if (!cfg || typeof cfg.token !== 'string' || cfg.token.length === 0) {
    throw new Error('GitHub token missing from system-config-github');
  }
  const token = looksEncrypted(cfg.token) ? decrypt(cfg.token, encryptionKey) : cfg.token;

  let owner = input.repoOwner?.trim();
  let name = input.repoName?.trim();
  if (!owner || !name) {
    const repoStr = typeof cfg.repo === 'string' ? cfg.repo.trim() : '';
    const slashIdx = repoStr.indexOf('/');
    if (slashIdx > 0) {
      owner = owner || repoStr.slice(0, slashIdx).trim();
      name = name || repoStr.slice(slashIdx + 1).trim();
    }
  }
  if (!owner || !name) {
    throw new Error(
      'GitHub default repo not configured — set the Repository field on the GitHub tab in Settings',
    );
  }

  const body = buildToolRequestIssueBody(row);
  const title = `[tool-request] ${row.displayTitle}`;

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`;
  const labels = input.labels && input.labels.length > 0 ? input.labels : ['tool-request'];

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'bronco',
    },
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text.slice(0, 300)}`);
  }
  const issue = (await res.json()) as { html_url?: string; number?: number };
  if (!issue.html_url || typeof issue.number !== 'number') {
    throw new Error('GitHub API returned unexpected payload (missing html_url or number)');
  }

  await db.toolRequest.update({
    where: { id: row.id },
    data: {
      githubIssueUrl: issue.html_url,
      implementedInIssue: String(issue.number),
    },
  });

  logger.info(
    { toolRequestId: row.id, repo: `${owner}/${name}`, issueNumber: issue.number },
    'Created GitHub issue for tool request',
  );

  return { issueUrl: issue.html_url, issueNumber: issue.number };
}

export function buildToolRequestIssueBody(row: ToolRequestRow): string {
  const lines: string[] = [];
  lines.push(`## ${row.displayTitle}`);
  lines.push('');
  lines.push(row.description);
  lines.push('');
  if (row.suggestedInputs && typeof row.suggestedInputs === 'object') {
    lines.push('### Suggested Inputs');
    lines.push('```json');
    lines.push(JSON.stringify(row.suggestedInputs, null, 2));
    lines.push('```');
    lines.push('');
  }
  if (row.exampleUsage) {
    lines.push('### Example Usage');
    lines.push(row.exampleUsage);
    lines.push('');
  }
  lines.push(`### Rationale History (${row.rationales.length})`);
  for (const r of row.rationales) {
    const ticketLink = r.ticket ? ` — ticket #${r.ticket.ticketNumber} (${r.ticket.subject})` : '';
    const dt = new Date(r.createdAt).toISOString().slice(0, 10);
    lines.push(`- **[${r.source}]** ${dt}${ticketLink}: ${r.rationale}`);
  }
  const linkedCount = new Set(
    row.rationales.filter((r) => r.ticket).map((r) => r.ticket!.id),
  ).size;
  lines.push('');
  const shortCode = row.client.shortCode ?? '—';
  lines.push(
    `_Detected from ${linkedCount} ticket(s) · client: ${row.client.name} (${shortCode}) · requestCount: ${row.requestCount}_`,
  );
  return lines.join('\n');
}
