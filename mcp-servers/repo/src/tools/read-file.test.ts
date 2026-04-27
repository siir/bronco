/**
 * Unit tests for read-file tool.
 *
 * Specifically the sanitizeFilePath helper (which is private in the module) —
 * we re-implement the same logic here so the contract is crystal-clear.
 * Any divergence between this test and the production code is a bug.
 *
 * We also exercise the secondary path-traversal guard (resolve + relative
 * check) on real temp dirs to verify its string-level semantics. Note: this
 * guard does NOT detect OS-level symlink escapes — `path.resolve()` only
 * normalizes path segments, it does not follow symlinks. See the test below
 * that documents this limitation.
 */

import { describe, expect, it } from 'vitest';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mirror of sanitizeFilePath from read-file.ts (must match production logic)
// ---------------------------------------------------------------------------

function sanitizeFilePath(fp: string): string | null {
  if (!fp || fp.startsWith('/')) return null;
  const normalized = fp.replace(/\\/g, '/');
  if (normalized.split('/').some((seg) => seg === '..')) return null;
  return normalized.replace(/^\.\//, '');
}

// ---------------------------------------------------------------------------
// Mirror of the secondary belt-and-suspenders guard
// ---------------------------------------------------------------------------

function isInsideWorktree(worktreePath: string, filePath: string): boolean {
  const absolutePath = resolve(join(worktreePath, filePath));
  const relToWorktree = relative(worktreePath, absolutePath);
  return relToWorktree !== '' && !relToWorktree.startsWith('..') && !isAbsolute(relToWorktree);
}

// ---------------------------------------------------------------------------
// sanitizeFilePath tests
// ---------------------------------------------------------------------------

describe('read-file: sanitizeFilePath', () => {
  it('accepts a simple relative path', () => {
    expect(sanitizeFilePath('src/index.ts')).toBe('src/index.ts');
  });

  it('strips leading ./', () => {
    expect(sanitizeFilePath('./src/foo.ts')).toBe('src/foo.ts');
  });

  it('accepts a filename with no directory component', () => {
    expect(sanitizeFilePath('README.md')).toBe('README.md');
  });

  it('rejects an absolute path', () => {
    expect(sanitizeFilePath('/etc/passwd')).toBeNull();
  });

  it('rejects .. traversal segment', () => {
    expect(sanitizeFilePath('../secret')).toBeNull();
  });

  it('rejects embedded .. in the middle', () => {
    expect(sanitizeFilePath('src/../../etc/passwd')).toBeNull();
  });

  it('rejects Windows-style backslash path traversal', () => {
    // Backslashes are normalised to / before the .. check
    expect(sanitizeFilePath('src\\..\\..\\secret')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(sanitizeFilePath('')).toBeNull();
  });

  it('accepts nested paths', () => {
    expect(sanitizeFilePath('a/b/c/d.ts')).toBe('a/b/c/d.ts');
  });

  it('rejects path that is only ..', () => {
    expect(sanitizeFilePath('..')).toBeNull();
  });

  it('does not reject dots in filenames', () => {
    expect(sanitizeFilePath('dist/index.d.ts')).toBe('dist/index.d.ts');
  });
});

// ---------------------------------------------------------------------------
// Secondary guard: resolve + relative (symlink escape detection)
// ---------------------------------------------------------------------------

describe('read-file: secondary path guard (resolve + relative)', () => {
  it('path inside worktree is accepted', () => {
    const worktree = '/srv/repos/worktrees/session1/repo1';
    expect(isInsideWorktree(worktree, 'src/foo.ts')).toBe(true);
  });

  it('parent directory reference is rejected by secondary guard', () => {
    const worktree = '/srv/repos/worktrees/session1/repo1';
    // sanitizeFilePath already rejects this, but secondary guard must also
    expect(isInsideWorktree(worktree, '../other-repo/secret')).toBe(false);
  });

  it('absolute path is handled by sanitizeFilePath, not the secondary guard', () => {
    // sanitizeFilePath rejects absolute paths up-front (returns null), so the
    // secondary guard is never called with one in production. Calling it
    // directly with `/etc/passwd` is misleading: Node's path.join does NOT
    // reset on a leading slash (path.resolve does), so it joins to a subdir
    // of the worktree and the secondary guard correctly classifies that as
    // "inside worktree". The defense lives in sanitizeFilePath.
    expect(sanitizeFilePath('/etc/passwd')).toBeNull();
  });

  it('documents limitation: string-level resolve does not detect symlink escape', async () => {
    // Create a temp worktree + a symlink pointing outside it. We're explicitly
    // documenting that the resolve+relative guard catches string-level `..`
    // traversal but NOT OS-level symlinks: `path.resolve()` normalizes segments,
    // it doesn't follow links. Real symlink-escape protection would require
    // `fs.realpath()` (or stat-based checks) before the relative comparison.
    const tmpBase = await mkdtemp(join(tmpdir(), 'bronco-test-'));
    const worktree = join(tmpBase, 'worktree');
    const outside = join(tmpBase, 'outside');
    await mkdir(worktree);
    await mkdir(outside);

    const symlinkPath = join(worktree, 'evil-link');
    await symlink(outside, symlinkPath);

    // The symlink path itself is inside worktree/ at the string level,
    // so the guard incorrectly classifies it as "inside" — proving the
    // limitation.
    expect(isInsideWorktree(worktree, 'evil-link')).toBe(true);

    await rm(tmpBase, { recursive: true, force: true });
  });
});
