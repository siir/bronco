import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLogger } from '@bronco/shared-utils';
import { PROTECTED_BRANCH_NAMES } from '@bronco/shared-types';

const logger = createLogger('issue-resolver:git');

const VALID_REPO_URL = /^(?:https?:\/\/|git@)[^\s]+$/;

/** Timeout (ms) for git clone/fetch operations to prevent indefinite blocking. */
const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// In-process mutex for clone/fetch operations
// Prevents concurrent jobs for the same repo from racing on git operations.
// ---------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<void>>();

function acquireRepoLock(repoUrl: string): { wait: Promise<void>; release: () => void } {
  const prev = repoLocks.get(repoUrl) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => {
    release = res;
  });
  const chain = prev.then(() => next);
  repoLocks.set(repoUrl, chain);
  chain.finally(() => {
    if (repoLocks.get(repoUrl) === chain) {
      repoLocks.delete(repoUrl);
    }
  });
  return { wait: prev, release };
}

/**
 * Throws if `branchName` is a protected branch or matches the repo's default branch.
 * The resolver must always work on a prefixed feature branch.
 */
function assertNotProtected(branchName: string, defaultBranch: string): void {
  const normalized = branchName.trim().toLowerCase();
  if (PROTECTED_BRANCH_NAMES.has(normalized) || normalized === defaultBranch.trim().toLowerCase()) {
    throw new Error(
      `Refusing to operate on protected branch "${branchName}". ` +
        'The issue resolver must always push to a branch under branchPrefix, never to main/master or the default branch.',
    );
  }
  // Must contain a slash (branchPrefix/slug format)
  if (!branchName.includes('/')) {
    throw new Error(
      `Branch name "${branchName}" does not contain a prefix separator (/). ` +
        'Expected format: {branchPrefix}/{slug}.',
    );
  }
}

export interface RepoContext {
  git: SimpleGit;
  localPath: string;
}

/**
 * Clone a repo (or open an existing clone), check out the default branch,
 * pull latest, then create and switch to the working branch.
 */
export async function prepareRepo(opts: {
  repoUrl: string;
  defaultBranch: string;
  branchName: string;
  workspacePath: string;
  authorName: string;
  authorEmail: string;
  /** Shallow clone depth. 0 or undefined = full clone. */
  cloneDepth?: number;
}): Promise<RepoContext> {
  const { repoUrl, defaultBranch, branchName, workspacePath, authorName, authorEmail, cloneDepth } = opts;

  // Validate repo URL format
  if (!VALID_REPO_URL.test(repoUrl)) {
    throw new Error(
      `Invalid repository URL: "${repoUrl}". Expected https:// or git@ format.`,
    );
  }

  // Safety: never allow operating directly on a protected branch
  assertNotProtected(branchName, defaultBranch);

  // Deterministic local path based on repo URL
  const repoHash = createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
  const localPath = join(workspacePath, repoHash);

  await mkdir(workspacePath, { recursive: true });

  // Lock the repo for the full duration of clone/fetch + checkout/reset
  // so concurrent jobs for the same repoUrl don't corrupt the working tree.
  const lock = acquireRepoLock(repoUrl);
  await lock.wait;

  let git: SimpleGit;

  const shallow = (cloneDepth ?? 0) > 0;

  try {
    if (existsSync(join(localPath, '.git'))) {
      logger.info({ repoUrl, localPath }, 'Opening existing clone');
      git = simpleGit(localPath, { timeout: { block: GIT_CLONE_TIMEOUT_MS } });
      await git.fetch('origin', shallow ? ['--depth', String(cloneDepth)] : []);
    } else {
      logger.info({ repoUrl, localPath, cloneDepth: shallow ? cloneDepth : 'full' }, 'Cloning repo');
      const cloneOpts = shallow ? ['--depth', String(cloneDepth)] : [];
      await simpleGit({ timeout: { block: GIT_CLONE_TIMEOUT_MS } }).clone(repoUrl, localPath, cloneOpts);
      git = simpleGit(localPath, { timeout: { block: GIT_CLONE_TIMEOUT_MS } });
    }

    // Configure author for commits
    await git.addConfig('user.name', authorName);
    await git.addConfig('user.email', authorEmail);

    // Ensure the default branch exists before checking out
    const remoteBranches = await git.branch(['-r']);
    if (!remoteBranches.all.includes(`origin/${defaultBranch}`)) {
      const available = remoteBranches.all.map((b) => b.replace('origin/', '')).join(', ');
      throw new Error(
        `Default branch "${defaultBranch}" not found in remote. Available branches: ${available}`,
      );
    }

    await git.checkout(defaultBranch);
    if (shallow) {
      await git.fetch('origin', defaultBranch, ['--depth', String(cloneDepth)]);
      await git.reset(['--hard', `origin/${defaultBranch}`]);
    } else {
      await git.pull('origin', defaultBranch);
    }

    // Create the working branch (force-reset if it already exists)
    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      await git.checkout(branchName);
      await git.reset(['--hard', `origin/${defaultBranch}`]);
    } else {
      await git.checkoutLocalBranch(branchName);
    }
  } finally {
    lock.release();
  }

  logger.info({ branchName }, 'Working branch ready');
  return { git, localPath };
}

export interface CommitResult {
  sha: string;
  filesChanged: number;
}

/**
 * Stage all changes, commit, and push the working branch.
 * Refuses to push to any protected branch (main, master, etc.).
 */
export async function commitAndPush(
  git: SimpleGit,
  branchName: string,
  message: string,
  defaultBranch?: string,
): Promise<CommitResult> {
  // Double-check: never push to a protected branch
  assertNotProtected(branchName, defaultBranch ?? 'master');

  await git.add('-A');

  const status = await git.status();
  const filesChanged = status.staged.length;

  if (filesChanged === 0) {
    throw new Error('No changes to commit');
  }

  const commit = await git.commit(message);
  const sha = commit.commit;

  logger.info({ sha, filesChanged, branchName }, 'Committed changes');

  await git.push('origin', branchName, ['--force-with-lease']);
  logger.info({ branchName }, 'Pushed to remote');

  return { sha, filesChanged };
}

/**
 * Remove repo clones in `workspacePath` that haven't been modified within
 * `retentionDays`. Runs best-effort — errors are logged but never propagated.
 */
export async function cleanupStaleClones(
  workspacePath: string,
  retentionDays: number,
): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(workspacePath);
  } catch {
    // Directory doesn't exist yet — nothing to clean
    return;
  }

  for (const entry of entries) {
    try {
      const entryPath = join(workspacePath, entry);
      const info = await stat(entryPath);
      if (!info.isDirectory()) continue;
      // Use mtime as a proxy for last activity — git operations update it
      if (info.mtimeMs < cutoff) {
        await rm(entryPath, { recursive: true, force: true });
        logger.info({ clone: entry, ageDays: Math.round((Date.now() - info.mtimeMs) / 86_400_000) }, 'Removed stale repo clone');
      }
    } catch (err) {
      logger.warn({ entry, err }, 'Failed to clean up repo clone');
    }
  }
}
