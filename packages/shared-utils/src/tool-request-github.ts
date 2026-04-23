import { PrismaClient } from '@bronco/db';
import { createLogger } from './logger.js';
import { decrypt, looksEncrypted } from './crypto.js';

const logger = createLogger('tool-request-github');

const SETTINGS_KEY_GITHUB = 'system-config-github';
const SETTINGS_KEY_GITHUB_DEFAULT_REPO = 'tool-requests-github-default-repo';

interface ResolvedGithubCreds {
  /** Decrypted PAT, ready to send as `Authorization: Bearer <token>`. */
  token: string;
  /** Optional host override (GitHub Enterprise). Defaults to github.com. */
  host?: string;
  /** For logging/debugging: where the credential came from. */
  source: 'integration-platform' | 'app-setting';
}

/**
 * Resolve the platform-level GitHub credentials used for tool-request issue
 * creation. Prefers a platform-scoped GITHUB integration (clientId IS NULL);
 * falls back to the legacy `system-config-github` AppSetting so deploys that
 * haven't been migrated keep working.
 *
 * Returns null if no source is configured. Callers should throw with a
 * helpful message in that case.
 *
 * Dual-read is intentional (issue #368): for one release we read from both
 * sources so the operator can migrate at their own pace. The AppSetting can be
 * removed in a later release.
 *
 * NOTE: `github_app` kind is not yet supported here; the caller will see a
 * thrown error. PAT remains the v1 flow.
 */
async function resolvePlatformGithubCreds(
  db: PrismaClient,
  encryptionKey: string,
): Promise<ResolvedGithubCreds | null> {
  // 1. Prefer platform-scoped GITHUB integration
  const integration = await db.clientIntegration.findFirst({
    where: { type: 'GITHUB', clientId: null, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (integration) {
    const cfg = integration.config as Record<string, unknown> | null;
    if (cfg && cfg.kind === 'pat' && typeof cfg.encryptedToken === 'string' && cfg.encryptedToken.length > 0) {
      const token = looksEncrypted(cfg.encryptedToken)
        ? decrypt(cfg.encryptedToken, encryptionKey)
        : cfg.encryptedToken;
      return {
        token,
        host: typeof cfg.host === 'string' ? cfg.host : undefined,
        source: 'integration-platform',
      };
    }
    if (cfg && cfg.kind === 'github_app') {
      // Surface a clear error rather than silently falling back — if the
      // operator configured a github_app integration, they intended for it to
      // be used.
      throw new Error(
        'Platform GITHUB integration uses kind="github_app" but tool-request issue creation does not yet support GitHub App token-minting. Configure a PAT integration or use the legacy system-config-github AppSetting for now.',
      );
    }
    logger.warn(
      { integrationId: integration.id },
      'Platform GITHUB integration found but config is malformed — falling back to system-config-github AppSetting',
    );
  }

  // 2. Legacy AppSetting fallback
  const githubRow = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_GITHUB } });
  if (!githubRow) return null;
  const cfg = githubRow.value as { token?: string } | null;
  if (!cfg || typeof cfg.token !== 'string' || cfg.token.length === 0) return null;
  const token = looksEncrypted(cfg.token) ? decrypt(cfg.token, encryptionKey) : cfg.token;
  return { token, source: 'app-setting' };
}

/**
 * Resolve the default "owner/name" target repo for tool-request issues. Prefers
 * the `tool-requests-github-default-repo` AppSetting, then falls back to the
 * legacy `system-config-github.repo` field (for backward compat with deploys
 * that only set the latter).
 */
async function resolveDefaultRepoString(db: PrismaClient): Promise<string | null> {
  const override = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_GITHUB_DEFAULT_REPO } });
  if (override) {
    const v = override.value;
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (v && typeof v === 'object' && 'repo' in v && typeof (v as { repo?: unknown }).repo === 'string') {
      const r = (v as { repo: string }).repo.trim();
      if (r) return r;
    }
  }
  const legacy = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_GITHUB } });
  if (legacy) {
    const v = legacy.value as { repo?: string } | null;
    if (v && typeof v.repo === 'string' && v.repo.trim().length > 0) return v.repo.trim();
  }
  return null;
}

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
 * Validates and parses a GitHub repo string in the form "owner/name".
 * Throws if the string does not contain exactly two non-empty segments.
 */
function parseRepoString(raw: string): { owner: string; name: string } {
  const trimmed = raw.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid GitHub repo format: "${raw}" — expected "owner/name" with exactly two non-empty segments. Configure this under Settings → GitHub → Repository.`,
    );
  }
  return { owner: parts[0], name: parts[1] };
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

  const creds = await resolvePlatformGithubCreds(db, encryptionKey);
  if (!creds) {
    throw new Error(
      'GitHub credentials not configured — add a platform-scoped GITHUB integration (Settings → Integrations) or set the legacy system-config-github AppSetting',
    );
  }

  let owner = input.repoOwner?.trim();
  let name = input.repoName?.trim();
  if (!owner || !name) {
    const repoStr = await resolveDefaultRepoString(db);
    if (repoStr) {
      const parsed = parseRepoString(repoStr);
      owner = owner || parsed.owner;
      name = name || parsed.name;
    }
  }
  if (!owner || !name) {
    throw new Error(
      'GitHub default repo not configured — set the `tool-requests-github-default-repo` AppSetting or pass repoOwner/repoName',
    );
  }

  const body = buildToolRequestIssueBody(row);
  const title = `[tool-request] ${row.displayTitle}`;

  // Build the API base URL so GHES hosts are supported. GHES uses
  // `https://<host>/api/v3` whereas github.com uses `https://api.github.com`.
  const apiBase =
    !creds.host || creds.host === 'github.com'
      ? 'https://api.github.com'
      : `https://${creds.host}/api/v3`;
  const url = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`;
  const labels = input.labels && input.labels.length > 0 ? input.labels : ['tool-request'];

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.token}`,
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
    { toolRequestId: row.id, repo: `${owner}/${name}`, issueNumber: issue.number, credSource: creds.source },
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
