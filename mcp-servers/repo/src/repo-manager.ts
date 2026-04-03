import { execFile } from 'node:child_process';
import { mkdir, rm, access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PrismaClient } from '@bronco/db';
import { createLogger } from '@bronco/shared-utils';
import type { Config } from './config.js';

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
    const repo = await this.db.codeRepo.findUnique({ where: { id: repoId } });
    if (!repo) throw new Error(`CodeRepo not found: ${repoId}`);
    if (!repo.isActive) throw new Error(`CodeRepo is inactive: ${repoId}`);

    const barePath = join(this.config.REPO_WORKSPACE_PATH, `${repoId}.git`);

    if (await this.pathExists(barePath)) {
      logger.info({ repoId, barePath }, 'Fetching updates for bare clone');
      await execFileAsync('git', ['fetch', '--all'], { cwd: barePath });
    } else {
      logger.info({ repoId, barePath }, 'Cloning bare repository');
      await mkdir(this.config.REPO_WORKSPACE_PATH, { recursive: true });
      await execFileAsync('git', ['clone', '--bare', repo.repoUrl, barePath]);
    }

    return barePath;
  }

  async createWorktree(repoId: string, sessionId: string): Promise<string> {
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

    return this.createWorktree(repoId, sessionId);
  }

  async cleanupSession(sessionId: string): Promise<void> {
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
