import { execFile } from 'node:child_process';
import { mkdir, rm, access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PrismaClient } from '@bronco/db';
import { createLogger } from '@bronco/shared-utils';
import type { Config } from './config.js';
import { resolveCloneUrl } from './github-clone-url.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('repo-manager');

interface WorktreeEntry {
  repoId: string;
  sessionId: string;
  path: string;
  createdAt: number;
}

export class RepoManager {
  private worktrees = new Map<string, WorktreeEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  // Promise-coalescing caches (#472). Concurrent callers for the same key
  // share the in-flight promise so we never run `git clone` / `git fetch` /
  // `git worktree add` against the same path simultaneously — a single bare
  // repo or worktree path can only support one mutating git op at a time
  // (bare repos hold their lock files directly under the repo directory,
  // e.g. `index.lock`; worktrees hold them under their own `.git/`), and
  // parallel orchestrated-v2 sub-tasks all share the same `gather-{ticketId}`
  // sessionId.
  //
  // Entries are removed in `.finally()` regardless of resolution, so a
  // failed first attempt won't permanently poison the slot.
  private cloneInFlight = new Map<string, Promise<string>>();
  private worktreeInFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: PrismaClient,
    private readonly config: Config,
  ) {}

  start(): void {
    // Recover any worktrees left on disk from a previous process run
    this.recoverOrphanedWorktrees().catch((err) => {
      logger.error({ err }, 'Failed to recover orphaned worktrees');
    });
    this.cleanupTimer = setInterval(() => {
      this.cleanupStale().catch((err) => {
        logger.error({ err }, 'Stale worktree cleanup failed');
      });
    }, 5 * 60 * 1000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async clone(repoId: string): Promise<string> {
    // Coalesce concurrent calls for the same repo — both `git clone --bare`
    // and `git fetch --all` lock the bare repo, so two parallel callers will
    // race on the lock file. See #472.
    const inflight = this.cloneInFlight.get(repoId);
    if (inflight) return inflight;
    const promise = this.cloneImpl(repoId).finally(() => {
      this.cloneInFlight.delete(repoId);
    });
    this.cloneInFlight.set(repoId, promise);
    return promise;
  }

  private async cloneImpl(repoId: string): Promise<string> {
    const repo = await this.db.codeRepo.findUnique({ where: { id: repoId } });
    if (!repo) throw new Error(`CodeRepo not found: ${repoId}`);
    if (!repo.isActive) throw new Error(`CodeRepo is inactive: ${repoId}`);

    const barePath = join(this.config.REPO_WORKSPACE_PATH, `${repoId}.git`);

    // Resolve the clone URL through the GITHUB integration chain (repo-level →
    // platform-scoped → legacy/unchanged). Rebuild on every call so rotated
    // tokens and newly-configured integrations take effect without restarting
    // this service.
    const cloneUrl = await resolveCloneUrl(this.db, this.config.ENCRYPTION_KEY, {
      id: repo.id,
      repoUrl: repo.repoUrl,
      githubIntegrationId: repo.githubIntegrationId,
      clientId: repo.clientId,
    });

    if (await this.pathExists(barePath)) {
      // Compare against the current remote URL rather than `repo.repoUrl` so we
      // also reset stale tokenized remotes back to the plain URL when an integration
      // is removed (not just when a new token is injected).
      const { stdout: originUrlStdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: barePath });
      const originUrl = originUrlStdout.trim();
      if (originUrl !== cloneUrl) {
        await execFileAsync('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: barePath });
      }
      logger.info({ repoId, barePath }, 'Fetching updates for bare clone');
      await execFileAsync('git', ['fetch', '--all'], { cwd: barePath });
    } else {
      logger.info({ repoId, barePath, usedGithubIntegration: cloneUrl !== repo.repoUrl }, 'Cloning bare repository');
      await mkdir(this.config.REPO_WORKSPACE_PATH, { recursive: true });
      await execFileAsync('git', ['clone', '--bare', cloneUrl, barePath]);
    }

    // Scrub the token-embedded URL from .git/config so the PAT is not stored on
    // disk at rest. We reset the remote to the plain URL immediately after the
    // clone/fetch completes; future operations will re-inject via the in-memory
    // cloneUrl resolved above.  This does NOT break subsequent git operations on
    // the bare repo because all fetched objects are already in the object store.
    if (cloneUrl !== repo.repoUrl) {
      await execFileAsync('git', ['remote', 'set-url', 'origin', repo.repoUrl], { cwd: barePath });
    }

    return barePath;
  }

  // protected so the only public path through createWorktree is via
  // getOrCreateWorktree (which coalesces concurrent calls). The protected
  // visibility still allows the test subclass in repo-manager.test.ts to
  // override this method for instrumentation. See #472.
  protected async createWorktree(repoId: string, sessionId: string): Promise<string> {
    const repo = await this.db.codeRepo.findUnique({ where: { id: repoId } });
    if (!repo) throw new Error(`CodeRepo not found: ${repoId}`);

    const barePath = await this.clone(repoId);
    const worktreePath = join(
      this.config.REPO_WORKSPACE_PATH,
      'worktrees',
      sessionId,
      repoId,
    );

    await mkdir(join(this.config.REPO_WORKSPACE_PATH, 'worktrees', sessionId), {
      recursive: true,
    });

    logger.info({ repoId, sessionId, worktreePath, branch: repo.defaultBranch }, 'Creating worktree');
    await execFileAsync('git', [
      'worktree',
      'add',
      worktreePath,
      repo.defaultBranch,
    ], { cwd: barePath });

    // Create ./tmp/ inside the worktree for allowed write output
    await mkdir(join(worktreePath, 'tmp'), { recursive: true });

    const key = `${sessionId}:${repoId}`;
    this.worktrees.set(key, {
      repoId,
      sessionId,
      path: worktreePath,
      createdAt: Date.now(),
    });

    return worktreePath;
  }

  async getOrCreateWorktree(repoId: string, sessionId: string): Promise<string> {
    const key = `${sessionId}:${repoId}`;
    const existing = this.worktrees.get(key);

    if (existing && (await this.pathExists(existing.path))) {
      return existing.path;
    }

    // Coalesce concurrent creates for the same key. Without this, parallel
    // orchestrated-v2 sub-tasks sharing a `gather-{ticketId}` sessionId all
    // see the missing-worktree state, all call createWorktree, and all race
    // on `git worktree add` to the same path — leaving 4 of 5 sub-tasks
    // failing with non-retryable errors. See #472.
    const inflight = this.worktreeInFlight.get(key);
    if (inflight) return inflight;
    const promise = this.createWorktree(repoId, sessionId).finally(() => {
      this.worktreeInFlight.delete(key);
    });
    this.worktreeInFlight.set(key, promise);
    return promise;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    // Wait for any in-flight worktree creates for THIS sessionId to settle
    // before we delete the session directory. Without this, a `cleanupSession`
    // call landing during a parallel create would race the create's git ops
    // against our `rm -rf` and produce confusing failures (#472 review).
    //
    // We snapshot the pending promises into an array — iterating
    // `worktreeInFlight` directly while creates settle could trip a "Map was
    // modified during iteration" guard if a `.finally()` fires mid-iteration.
    // Settled creates rather than rejected ones are fine (we're about to
    // delete anyway) so we swallow rejections via `.catch(() => undefined)`.
    const sessionPrefix = `${sessionId}:`;
    const pendingForSession: Array<Promise<unknown>> = [];
    for (const [key, promise] of this.worktreeInFlight) {
      if (key.startsWith(sessionPrefix)) {
        pendingForSession.push(promise.catch(() => undefined));
      }
    }
    if (pendingForSession.length > 0) {
      await Promise.all(pendingForSession);
    }

    const toRemove: string[] = [];
    for (const [key, entry] of this.worktrees) {
      if (entry.sessionId === sessionId) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      const entry = this.worktrees.get(key)!;
      await this.removeWorktree(entry);
      this.worktrees.delete(key);
    }

    // Also remove the session directory
    const sessionDir = join(this.config.REPO_WORKSPACE_PATH, 'worktrees', sessionId);
    if (await this.pathExists(sessionDir)) {
      await rm(sessionDir, { recursive: true, force: true });
    }

    logger.info({ sessionId, removed: toRemove.length }, 'Cleaned up session worktrees');
  }

  private async recoverOrphanedWorktrees(): Promise<void> {
    const worktreesDir = join(this.config.REPO_WORKSPACE_PATH, 'worktrees');
    if (!(await this.pathExists(worktreesDir))) return;

    const sessions = await readdir(worktreesDir).catch(() => [] as string[]);
    let recovered = 0;
    for (const sessionId of sessions) {
      const sessionDir = join(worktreesDir, sessionId);
      const repos = await readdir(sessionDir).catch(() => [] as string[]);
      for (const repoId of repos) {
        const worktreePath = join(sessionDir, repoId);
        const key = `${sessionId}:${repoId}`;
        if (!this.worktrees.has(key)) {
          const info = await stat(worktreePath).catch(() => null);
          if (info?.isDirectory()) {
            this.worktrees.set(key, {
              repoId,
              sessionId,
              path: worktreePath,
              createdAt: info.mtimeMs,
            });
            recovered++;
          }
        }
      }
    }
    if (recovered > 0) {
      logger.info({ recovered }, 'Recovered orphaned worktrees from disk');
    }
  }

  async cleanupStale(): Promise<void> {
    const ttlMs = this.config.WORKTREE_TTL_MINUTES * 60 * 1000;
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, entry] of this.worktrees) {
      if (now - entry.createdAt > ttlMs) {
        toRemove.push(key);
      }
    }

    if (toRemove.length === 0) return;

    for (const key of toRemove) {
      const entry = this.worktrees.get(key)!;
      await this.removeWorktree(entry);
      this.worktrees.delete(key);
    }

    // Clean up empty session directories
    const worktreesDir = join(this.config.REPO_WORKSPACE_PATH, 'worktrees');
    if (await this.pathExists(worktreesDir)) {
      const sessions = await readdir(worktreesDir);
      for (const session of sessions) {
        const sessionDir = join(worktreesDir, session);
        const contents = await readdir(sessionDir).catch(() => []);
        if (contents.length === 0) {
          await rm(sessionDir, { recursive: true, force: true });
        }
      }
    }

    logger.info({ removed: toRemove.length }, 'Cleaned up stale worktrees');
  }

  private async removeWorktree(entry: WorktreeEntry): Promise<void> {
    const barePath = join(this.config.REPO_WORKSPACE_PATH, `${entry.repoId}.git`);
    try {
      if (await this.pathExists(barePath)) {
        await execFileAsync('git', ['worktree', 'remove', '--force', entry.path], {
          cwd: barePath,
        });
      }
    } catch (err) {
      logger.warn({ err, path: entry.path }, 'git worktree remove failed, removing directory directly');
    }
    // Always try to clean up the directory
    await rm(entry.path, { recursive: true, force: true }).catch(() => {});
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }
}
