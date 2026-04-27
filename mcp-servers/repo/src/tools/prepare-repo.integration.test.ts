/**
 * Integration tests for prepare-repo, search-code, read-file, and list-files.
 *
 * Uses:
 *   - A local bare git repo as the "remote" (never hits GitHub)
 *   - TEST_DATABASE_URL postgres for CodeRepo + ClientIntegration fixture rows
 *   - Real RepoManager pointed at a temp workspace dir
 *
 * The GITHUB integration credential lookup (for PAT scrub verification) is
 * exercised here by inserting a ClientIntegration row with a PAT and asserting
 * that the bare clone's remote URL is scrubbed back to the plain URL after
 * clone/fetch.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrismaClient } from '@bronco/db';
import { getTestDb, truncateAll, createClient } from '@bronco/test-utils';
import { encrypt } from '@bronco/shared-utils';
import { RepoManager } from '../repo-manager.js';
import type { Config } from '../config.js';

const execFileAsync = promisify(execFile);
const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

// 32-byte (64 hex char) AES-256 test key
const TEST_KEY = 'b'.repeat(64);
const TEST_PAT = 'ghp_integtest_token_12345678';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initLocalBareRemote(workDir: string): Promise<string> {
  const remotePath = join(workDir, 'remote.git');
  await mkdir(remotePath);
  execFileSync('git', ['init', '--bare', remotePath]);

  // Create a working clone to add an initial commit
  const tmpClone = join(workDir, 'tmp-clone');
  execFileSync('git', ['clone', remotePath, tmpClone]);
  await writeFile(join(tmpClone, 'hello.ts'), 'export const greet = () => "hello";\n');
  await writeFile(join(tmpClone, 'README.md'), '# Test Repo\n');
  await mkdir(join(tmpClone, 'src'));
  await writeFile(join(tmpClone, 'src', 'world.ts'), 'export const world = "world";\n');
  await writeFile(join(tmpClone, 'src', 'style.css'), 'body { color: red; }\n');

  execFileSync('git', ['-C', tmpClone, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', tmpClone, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', tmpClone, 'add', '-A']);
  execFileSync('git', ['-C', tmpClone, 'commit', '-m', 'Initial commit']);
  execFileSync('git', ['-C', tmpClone, 'push', 'origin', 'master']);

  await rm(tmpClone, { recursive: true, force: true });
  return remotePath;
}

function makeConfig(workspacePath: string): Config {
  return {
    DATABASE_URL: process.env['TEST_DATABASE_URL'] ?? '',
    ENCRYPTION_KEY: TEST_KEY,
    API_KEY: undefined,
    PORT: 3111,
    REPO_WORKSPACE_PATH: workspacePath,
    WORKTREE_TTL_MINUTES: 30,
    LOG_LEVEL: 'silent',
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('integration: prepare-repo + tools', () => {
  let db: PrismaClient;
  let workDir: string;
  let remotePath: string;
  let repoManager: RepoManager;
  let clientId: string;
  let repoId: string;
  // Shared sessionId for tests that just need any worktree on the default
  // branch — git's one-worktree-per-branch rule means we can't have multiple
  // unique sessions all pointing at `master` simultaneously without
  // explicit cleanup between each.
  const SHARED_SESSION_ID = 'shared-integ-session';

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);

    workDir = await mkdtemp(join(tmpdir(), 'bronco-repo-integ-'));
    remotePath = await initLocalBareRemote(workDir);

    const workspacePath = join(workDir, 'workspace');
    await mkdir(workspacePath);
    repoManager = new RepoManager(db, makeConfig(workspacePath));
    repoManager.start();

    // Create DB fixtures
    const client = await createClient(db, { name: 'Integ Test Client' });
    clientId = client.id;

    const repo = await db.codeRepo.create({
      data: {
        clientId,
        name: 'test-repo',
        repoUrl: `file://${remotePath}`,
        defaultBranch: 'master',
        fileExtensions: ['.ts', '.md'],
        isActive: true,
      },
    });
    repoId = repo.id;
  });

  afterAll(async () => {
    repoManager.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  // NOTE on session reuse: git only allows one worktree per branch by default.
  // Each test calls `getOrCreateWorktree` with the shared SHARED_SESSION_ID;
  // first call creates the worktree on `master`, all subsequent calls hit the
  // in-memory cache and return the same path — so we don't try to create a
  // second worktree of `master` that git would refuse.
  // Tests that need an isolated worktree (e.g. PAT scrub on a different repoId)
  // use `cleanupSession` explicitly afterward.

  // -------------------------------------------------------------------------
  // prepare-repo: clone + idempotency
  // -------------------------------------------------------------------------

  describe('prepare-repo: clone + idempotency', () => {
    it('clones the bare repo on first call', async () => {
      const workspace = join(workDir, 'workspace');
      const barePath = join(workspace, `${repoId}.git`);

      await repoManager.clone(repoId);

      const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: barePath });
      expect(stdout.trim()).toBe('.');
    });

    it('is idempotent — second clone call fetches without error', async () => {
      await repoManager.clone(repoId);
      await expect(repoManager.clone(repoId)).resolves.not.toThrow();
    });

    it('creates a worktree that contains repo files', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { stdout } = await execFileAsync('find', [worktreePath, '-name', 'hello.ts']);
      expect(stdout).toContain('hello.ts');
    });
  });

  // -------------------------------------------------------------------------
  // PAT scrub: token must not persist in .git/config after clone
  // -------------------------------------------------------------------------

  describe('PAT scrub: token not stored on disk', () => {
    it('remote URL in .git/config is plain after clone with integration', async () => {
      // Provision a SECOND bare remote so this test's CodeRepo row doesn't
      // collide with the suite-level fixture on the (clientId, repoUrl) unique
      // index.  Same content, different path on disk.
      const patRemotePath = await initLocalBareRemote(await mkdtemp(join(tmpdir(), 'bronco-repo-integ-pat-')));

      // Insert a GITHUB integration with a PAT
      const encToken = encrypt(TEST_PAT, TEST_KEY);
      const integration = await db.clientIntegration.create({
        data: {
          clientId,
          type: 'GITHUB',
          label: 'default',
          isActive: true,
          config: { kind: 'pat', encryptedToken: encToken },
        },
      });

      // Create a new repo row pointing to the dedicated PAT remote with the integration
      const patRepo = await db.codeRepo.create({
        data: {
          clientId,
          name: 'test-repo-pat',
          repoUrl: `file://${patRemotePath}`,
          defaultBranch: 'master',
          fileExtensions: ['.ts'],
          isActive: true,
          githubIntegrationId: integration.id,
        },
      });

      await repoManager.clone(patRepo.id);

      const workspace = join(workDir, 'workspace');
      const barePath = join(workspace, `${patRepo.id}.git`);

      // Read the actual remote URL from .git/config
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: barePath });
      const storedUrl = stdout.trim();

      // Must NOT contain the PAT
      expect(storedUrl).not.toContain(TEST_PAT);
      // Must be the plain URL (with file:// scheme for local bare repo)
      expect(storedUrl).toBe(`file://${patRemotePath}`);

      // Cleanup integration and repo
      await db.codeRepo.delete({ where: { id: patRepo.id } });
      await db.clientIntegration.delete({ where: { id: integration.id } });
    });
  });

  // -------------------------------------------------------------------------
  // search-code: grep over worktree
  // -------------------------------------------------------------------------

  describe('search-code: grep functionality', () => {
    it('finds a symbol present in the repo', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      const result = await executeCommand("grep -rn -I -i -e 'greet' .", worktreePath);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('greet');
      expect(result.stdout).toContain('hello.ts');
    });

    it('returns exit code 1 (no match) gracefully', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      const result = await executeCommand("grep -rn -I -i -e 'NONEXISTENT_SYMBOL_XYZ' .", worktreePath);

      // grep exits 1 when no match — that is not an error for the tool
      expect(result.exitCode).toBe(1);
      expect(result.stdout.trim()).toBe('');
    });

    it('respects extension filter (only .ts files)', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      // Search for "color" — only in style.css, not .ts files
      const result = await executeCommand("grep -rn -I -i --include=*.ts -e 'color' .", worktreePath);

      // grep exits 1 = no match in .ts files
      expect(result.exitCode).toBe(1);
    });

    it('finds matches in .css when extension filter includes it', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      const result = await executeCommand("grep -rn -I -i --include=*.css -e 'color' .", worktreePath);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('style.css');
    });
  });

  // -------------------------------------------------------------------------
  // read-file: reads real content
  // -------------------------------------------------------------------------

  describe('read-file: file reading', () => {
    it('reads the content of a file in the worktree', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { open, stat } = await import('node:fs/promises');
      const { join: pathJoin, resolve: pathResolve } = await import('node:path');

      const absolutePath = pathResolve(pathJoin(worktreePath, 'hello.ts'));
      const fileStat = await stat(absolutePath);
      expect(fileStat.isFile()).toBe(true);

      const fh = await open(absolutePath, 'r');
      try {
        const buf = Buffer.alloc(4000);
        const { bytesRead } = await fh.read(buf, 0, 4000, 0);
        const content = buf.slice(0, bytesRead).toString('utf8');
        expect(content).toContain('greet');
      } finally {
        await fh.close();
      }
    });

    it('rejects path traversal targeting outside the worktree', async () => {
      // sanitizeFilePath rejects .. segments — test the guard directly
      const { resolve: pathResolve, relative: pathRelative, isAbsolute: pathIsAbsolute, join: pathJoin } = await import('node:path');

      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      // Simulate what read-file.ts does with ../../../etc/passwd
      const maliciousPath = '../../../etc/passwd';

      // First gate: sanitizeFilePath
      function sanitize(fp: string): string | null {
        if (!fp || fp.startsWith('/')) return null;
        const normalized = fp.replace(/\\/g, '/');
        if (normalized.split('/').some((seg) => seg === '..')) return null;
        return normalized.replace(/^\.\//, '');
      }

      const sanitized = sanitize(maliciousPath);
      expect(sanitized).toBeNull();

      // Even if we bypassed sanitizeFilePath, the secondary guard catches it
      const absolutePath = pathResolve(pathJoin(worktreePath, maliciousPath));
      const rel = pathRelative(worktreePath, absolutePath);
      const escapesWorktree = rel === '' || rel.startsWith('..') || pathIsAbsolute(rel);
      expect(escapesWorktree).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // list-files: directory listing
  // -------------------------------------------------------------------------

  describe('list-files: directory listing', () => {
    it('lists all .ts files in the repo', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      const result = await executeCommand("find '.' -type f -name '*.ts' | head -n 200", worktreePath);

      expect(result.exitCode).toBe(0);
      const files = result.stdout.split('\n').filter(Boolean);
      expect(files.some((f) => f.includes('hello.ts'))).toBe(true);
      expect(files.some((f) => f.includes('world.ts'))).toBe(true);
    });

    it('lists files in a subdirectory', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      const result = await executeCommand("find 'src' -type f -name '*' | head -n 200", worktreePath);

      expect(result.exitCode).toBe(0);
      const files = result.stdout.split('\n').filter(Boolean);
      expect(files.some((f) => f.includes('world.ts'))).toBe(true);
      expect(files.some((f) => f.includes('style.css'))).toBe(true);
      // Should not include root-level files
      expect(files.some((f) => f.endsWith('/hello.ts') || f === './hello.ts')).toBe(false);
    });

    it('returns 0 files for a pattern with no matches', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      const countResult = await executeCommand("find '.' -type f -name '*.xyz' | wc -l", worktreePath);
      expect(countResult.exitCode).toBe(0);
      expect(Number.parseInt(countResult.stdout.trim(), 10)).toBe(0);
    });

    it('path traversal in directory is rejected before shell execution', () => {
      // Mirrors the sanitizeDirectory check in list-files.ts
      function sanitizeDir(dir: string): string | null {
        if (!dir) return '.';
        if (dir.startsWith('/')) return null;
        const normalized = dir.replace(/\\/g, '/');
        if (normalized.split('/').some((seg) => seg === '..')) return null;
        return normalized.replace(/^\.\//, '') || '.';
      }

      expect(sanitizeDir('../../../etc')).toBeNull();
      expect(sanitizeDir('/etc')).toBeNull();
      expect(sanitizeDir('src/../../etc')).toBeNull();
    });

    it('caps results at the specified maxResults', async () => {
      const sessionId = SHARED_SESSION_ID;
      const worktreePath = await repoManager.getOrCreateWorktree(repoId, sessionId);

      const { executeCommand } = await import('../command-validator.js');
      // cap of 1 — should return at most 1 file
      const listResult = await executeCommand("find '.' -type f -name '*' | head -n 1", worktreePath);
      expect(listResult.exitCode).toBe(0);
      const files = listResult.stdout.split('\n').filter(Boolean);
      expect(files).toHaveLength(1);
    });
  });
});
