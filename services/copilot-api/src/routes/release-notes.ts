import type { FastifyInstance } from 'fastify';
import type { AIRouter } from '@bronco/ai-provider';
import { TaskType, ReleaseNoteType } from '@bronco/shared-types';
import type { Config } from '../config.js';

// Shape of a commit from github.event.commits in GitHub Actions
interface GHActionsCommit {
  id: string;          // SHA
  message: string;
  timestamp: string;   // ISO date
  added: string[];
  modified: string[];
  removed: string[];
}

// Shape of a commit from GitHub compare API
interface GHApiCommit {
  sha: string;
  commit: { message: string; author: { date: string } };
  files?: Array<{ filename: string }>;
}

const SKIP_ONLY_FILES = new Set(['pnpm-lock.yaml', 'package-lock.yaml']);

function isLockfileOnly(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every((f) => SKIP_ONLY_FILES.has(f) || f.endsWith('.lock'));
}

function extractServices(files: string[]): string[] {
  if (files.length === 0) return ['unknown'];
  const found = new Set<string>();
  for (const f of files) {
    if (f.startsWith('services/copilot-api/')) found.add('copilot-api');
    else if (f.startsWith('services/control-panel/')) found.add('control-panel');
    else if (f.startsWith('services/ticket-portal/')) found.add('control-panel');
    else if (f.startsWith('services/imap-worker/')) found.add('imap-worker');
    else if (f.startsWith('services/devops-worker/')) found.add('devops-worker');
    else if (f.startsWith('services/issue-resolver/')) found.add('issue-resolver');
    else if (f.startsWith('services/status-monitor/')) found.add('status-monitor');
    else if (f.startsWith('mcp-servers/')) found.add('mcp-server');
    else if (f.startsWith('packages/db/')) found.add('database');
    else if (
      f.startsWith('packages/shared-types/') ||
      f.startsWith('packages/shared-utils/') ||
      f.startsWith('packages/ai-provider/')
    ) found.add('core');
    else if (f.startsWith('.github/')) found.add('ci-cd');
    else found.add('other');
  }
  return Array.from(found).sort();
}

function extractChangeType(message: string): ReleaseNoteType {
  const lower = message.toLowerCase().trimStart();
  const prefix = lower.split(/[:(!\s]/)[0];
  if (prefix === 'feat' || prefix === 'feature') return ReleaseNoteType.FEATURE;
  if (prefix === 'fix') return ReleaseNoteType.FIX;
  if (['chore', 'docs', 'ci', 'refactor', 'style', 'test', 'build'].includes(prefix)) {
    return ReleaseNoteType.MAINTENANCE;
  }
  return ReleaseNoteType.OTHER;
}

function isMergeCommit(message: string): boolean {
  return message.trimStart().startsWith('Merge ');
}

interface ReleaseNoteRouteOpts {
  config: Config;
  ai: AIRouter;
}

export async function releaseNoteRoutes(fastify: FastifyInstance, opts: ReleaseNoteRouteOpts): Promise<void> {
  const { config, ai } = opts;

  async function generateSummary(message: string, files: string[]): Promise<string | null> {
    const fileList = files.slice(0, 20).join(', ') || 'none';
    const prompt = `Commit message: ${message}\n\nChanged files: ${fileList}`;
    try {
      const result = await ai.generate({
        taskType: TaskType.GENERATE_RELEASE_NOTE,
        prompt,
        promptKey: 'release-notes.generate.system',
      });
      return result.content.trim();
    } catch {
      return null;
    }
  }

  async function ingestCommit(
    sha: string,
    message: string,
    timestamp: string,
    files: string[],
    tag?: string,
  ): Promise<'ingested' | 'skipped'> {
    const trimmedMessage = message.trim();

    // Skip merge commits
    if (isMergeCommit(trimmedMessage)) return 'skipped';

    // Skip lockfile-only commits
    if (isLockfileOnly(files)) return 'skipped';

    // Skip already-stored commits, but backfill releaseTag if it was null and we now have one
    const existing = await fastify.db.releaseNote.findUnique({ where: { commitSha: sha }, select: { id: true, releaseTag: true } });
    if (existing) {
      if (tag && existing.releaseTag === null) {
        await fastify.db.releaseNote.update({ where: { id: existing.id }, data: { releaseTag: tag } });
      }
      return 'skipped';
    }

    const services = extractServices(files);
    const changeType = extractChangeType(trimmedMessage);
    const summary = await generateSummary(trimmedMessage, files);

    try {
      await fastify.db.releaseNote.create({
        data: {
          commitSha: sha,
          commitDate: new Date(timestamp),
          rawMessage: trimmedMessage,
          summary,
          services,
          changeType,
          releaseTag: tag ?? null,
        },
      });
    } catch (err: unknown) {
      // Race condition: concurrent ingest created this commit between our check and create.
      // Prisma P2002 = unique constraint violation — treat as skip.
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
        return 'skipped';
      }
      throw err;
    }

    return 'ingested';
  }

  // POST /api/release-notes/ingest
  fastify.post<{
    Body: Record<string, unknown>;
  }>('/api/release-notes/ingest', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    let ingested = 0;
    let skipped = 0;

    const bodyTag = typeof body.tag === 'string' && body.tag.trim() ? body.tag.trim() : undefined;
    const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+$/;
    if (bodyTag && !SEMVER_TAG_RE.test(bodyTag)) {
      reply.code(400);
      return { error: 'tag must be a valid semver version (e.g. v1.2.3).' };
    }

    if (Array.isArray(body.commits)) {
      // Body A: GitHub Actions push event commits
      for (const c of body.commits) {
        const entry = c as Record<string, unknown>;
        if (!entry || typeof entry !== 'object') continue;
        const id = entry.id as string | undefined;
        const message = entry.message as string | undefined;
        const timestamp = entry.timestamp as string | undefined;
        if (!id || typeof message !== 'string' || !timestamp) continue;
        if (Number.isNaN(new Date(timestamp).getTime())) continue;
        const added = Array.isArray(entry.added) ? entry.added as string[] : [];
        const modified = Array.isArray(entry.modified) ? entry.modified as string[] : [];
        const removed = Array.isArray(entry.removed) ? entry.removed as string[] : [];
        const files = [...added, ...modified, ...removed];
        const result = await ingestCommit(id, message, timestamp, files, bodyTag);
        if (result === 'ingested') ingested++;
        else skipped++;
      }
    } else if (typeof body.fromSha === 'string') {
      // Body B: manual backfill via GitHub compare API
      if (!config.GITHUB_TOKEN) {
        reply.code(503);
        return { error: 'GITHUB_TOKEN is not configured. Set it in the environment to enable manual backfill.' };
      }

      const repo = config.GITHUB_REPO;
      const shaOrRefPattern = /^[0-9a-f]{4,40}$|^[a-zA-Z][a-zA-Z0-9._/-]*$/;
      const fromShaRaw = body.fromSha as string;
      const toShaRaw = body.toSha as string | undefined;
      const fromSha = fromShaRaw.trim();
      const toSha = toShaRaw?.trim();

      if (!shaOrRefPattern.test(fromSha)) {
        reply.code(400);
        return { error: 'fromSha must be a valid commit SHA or Git reference.' };
      }
      if (!toSha) {
        reply.code(400);
        return { error: 'toSha is required and must be a non-empty Git reference (commit SHA, branch, or tag).' };
      }
      if (!shaOrRefPattern.test(toSha)) {
        reply.code(400);
        return { error: 'toSha must be a valid commit SHA or Git reference.' };
      }

      const url = `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(fromSha)}...${encodeURIComponent(toSha)}`;
      try {
        const ghResp = await fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${config.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });

        if (!ghResp.ok) {
          const text = await ghResp.text();
          reply.code(502);
          return { error: `GitHub API error ${ghResp.status}: ${text.slice(0, 200)}` };
        }

        const data = (await ghResp.json()) as {
          commits: GHApiCommit[];
          files?: Array<{ filename: string }>;
          total_commits?: number;
        };

        // The GitHub compare API caps results at 250 commits. If the range is
        // larger, only the first 250 are returned. Check total_commits and warn
        // the caller so they can narrow the range or paginate manually.
        const commits = data.commits ?? [];
        const apiTotalCommits = data.total_commits;
        const totalCommits = apiTotalCommits ?? commits.length;
        const MAX_COMPARE_COMMITS = 250;
        // When total_commits is absent, the fallback equals commits.length which
        // will never exceed 250 (the API cap). Treat hitting exactly the cap as a
        // truncation signal so the caller knows the range may be incomplete.
        const truncated =
          totalCommits > MAX_COMPARE_COMMITS || commits.length === MAX_COMPARE_COMMITS;

        // The GitHub compare API returns changed files at the top level (`data.files`),
        // not on each individual commit. Use the top-level list for all commits in this
        // backfill range so that downstream file-based logic (service extraction, lockfile
        // detection) still has access to the changed files.
        const backfillFiles = (data.files ?? []).map((f) => f.filename);
        for (const c of commits) {
          if (!c.sha || !c.commit?.message) continue;
          const timestamp = c.commit.author?.date ?? new Date().toISOString();
          const ingestOutcome = await ingestCommit(c.sha, c.commit.message, timestamp, backfillFiles, bodyTag);
          if (ingestOutcome === 'ingested') ingested++;
          else skipped++;
        }

        const response: Record<string, unknown> = { ingested, skipped };
        if (truncated) {
          const ofTotal = apiTotalCommits != null ? ` of ${apiTotalCommits} total` : '';
          response.warning = `GitHub compare API returned ${commits.length}${ofTotal} commits. Only the first ${MAX_COMPARE_COMMITS} are included. Narrow the SHA range or call this endpoint in smaller chunks to capture all commits.`;
          if (apiTotalCommits != null) response.totalCommits = apiTotalCommits;
        }
        return response;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          reply.code(504);
          return { error: 'GitHub compare API request timed out.' };
        }
        reply.code(502);
        return { error: 'Failed to call GitHub compare API.' };
      }
    } else {
      reply.code(400);
      return { error: 'Request body must include either "commits" array (GitHub Actions) or "fromSha" string (backfill).' };
    }

    return { ingested, skipped };
  });

  // GET /api/release-notes
  fastify.get<{
    Querystring: {
      service?: string;
      search?: string;
      from?: string;
      to?: string;
      changeType?: string;
      tag?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/release-notes', async (request) => {
    const {
      service,
      search,
      from,
      to,
      changeType,
      tag,
      limit: rawLimit = '50',
      offset: rawOffset = '0',
    } = request.query;

    const take = Math.min(Math.trunc(Number(rawLimit)), 200);
    const skip = Math.trunc(Number(rawOffset));
    if (!Number.isFinite(take) || take < 0 || !Number.isFinite(skip) || skip < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }

    const where: Record<string, unknown> = {};

    if (service) {
      where.services = { has: service };
    }
    if (search) {
      where.OR = [
        { rawMessage: { contains: search, mode: 'insensitive' } },
        { summary: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (from || to) {
      const commitDate: Record<string, Date> = {};
      if (from) {
        const d = new Date(from);
        if (Number.isNaN(d.getTime())) return fastify.httpErrors.badRequest('from must be a valid date');
        commitDate.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (Number.isNaN(d.getTime())) return fastify.httpErrors.badRequest('to must be a valid date');
        commitDate.lte = d;
      }
      where.commitDate = commitDate;
    }
    if (changeType) {
      const valid = new Set<string>(Object.values(ReleaseNoteType));
      if (!valid.has(changeType)) return fastify.httpErrors.badRequest(`Invalid changeType: ${changeType}`);
      where.changeType = changeType;
    }
    const normalizedTag = tag?.trim();
    if (normalizedTag) {
      where.releaseTag = normalizedTag;
    }

    const [total, items] = await Promise.all([
      fastify.db.releaseNote.count({ where }),
      fastify.db.releaseNote.findMany({
        where,
        orderBy: { commitDate: 'desc' },
        take,
        skip,
      }),
    ]);

    return { items, total };
  });

  // GET /api/release-notes/services
  fastify.get('/api/release-notes/services', async () => {
    const rows = await fastify.db.$queryRaw<{ service: string }[]>`
      SELECT DISTINCT unnest(services) AS service FROM release_notes ORDER BY service
    `;
    return rows.map((r) => r.service);
  });

  // GET /api/release-notes/tags
  fastify.get('/api/release-notes/tags', async () => {
    const rows = await fastify.db.releaseNote.findMany({
      where: { releaseTag: { not: null } },
      select: { releaseTag: true },
      distinct: ['releaseTag'],
    });
    const tags = rows.map((r) => r.releaseTag as string);
    // Sort semver-aware descending (numeric locale compare handles v0.0.10 > v0.0.2 correctly)
    tags.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    return tags;
  });

  // PATCH /api/release-notes/:id
  fastify.patch<{
    Params: { id: string };
    Body: { isVisible?: boolean };
  }>('/api/release-notes/:id', async (request) => {
    const { isVisible } = (request.body ?? {}) as { isVisible?: boolean };
    if (isVisible === undefined || typeof isVisible !== 'boolean') {
      return fastify.httpErrors.badRequest('isVisible must be a boolean');
    }

    const existing = await fastify.db.releaseNote.findUnique({
      where: { id: request.params.id },
      select: { id: true },
    });
    if (!existing) return fastify.httpErrors.notFound('Release note not found');

    return fastify.db.releaseNote.update({
      where: { id: request.params.id },
      data: { isVisible },
    });
  });
}
