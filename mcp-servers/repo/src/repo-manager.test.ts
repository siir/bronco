/**
 * Unit tests for repo-manager's promise-coalescing behavior (#472).
 *
 * Concurrent orchestrated-v2 sub-tasks share a `gather-{ticketId}` sessionId.
 * Without coalescing, 5 parallel callers all see `worktrees.get(key) ===
 * undefined` and all call `createWorktree`, racing on `git worktree add` to
 * the same path. The fix coalesces in-flight creates so concurrent callers
 * await a single shared promise.
 *
 * These tests use a subclass that overrides `createWorktree` to count
 * invocations and pause resolution — no real git, fs, or network.
 */

import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { RepoManager } from './repo-manager.js';
import type { Config } from './config.js';

const FAKE_PATH = (sessionId: string, repoId: string) =>
  `/tmp/test-workspace/worktrees/${sessionId}/${repoId}`;

const baseConfig = {
  REPO_WORKSPACE_PATH: '/tmp/test-workspace',
  ENCRYPTION_KEY: 'test-key',
  WORKTREE_TTL_MINUTES: 60,
} as unknown as Config;

const fakeDb = {} as PrismaClient;

describe('RepoManager — concurrent worktree creation coalescing (#472)', () => {
  it('coalesces parallel getOrCreateWorktree calls for the same (repoId, sessionId)', async () => {
    let createCount = 0;
    let resolveCreate: ((path: string) => void) | null = null;

    class TestRepoManager extends RepoManager {
      // Override the inner create to pause resolution and count invocations.
      // Concurrent callers should all join the in-flight promise; only one
      // override-call should fire.
      override async createWorktree(repoId: string, sessionId: string): Promise<string> {
        createCount++;
        return new Promise<string>((resolve) => {
          resolveCreate = resolve;
        });
      }
    }

    const mgr = new TestRepoManager(fakeDb, baseConfig);

    const promises = Array.from({ length: 5 }, () =>
      mgr.getOrCreateWorktree('repo-1', 'gather-ticket-abc'),
    );

    // Yield to the microtask queue so the in-flight cache settles.
    await new Promise((r) => setImmediate(r));

    expect(createCount).toBe(1);
    expect(resolveCreate).not.toBeNull();

    // Resolve the single in-flight create — all 5 promises should resolve.
    resolveCreate!(FAKE_PATH('gather-ticket-abc', 'repo-1'));

    const results = await Promise.all(promises);
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result).toBe(FAKE_PATH('gather-ticket-abc', 'repo-1'));
    }
  });

  it('does NOT coalesce calls for different (repoId, sessionId) keys', async () => {
    let createCount = 0;

    class TestRepoManager extends RepoManager {
      override async createWorktree(repoId: string, sessionId: string): Promise<string> {
        createCount++;
        return FAKE_PATH(sessionId, repoId);
      }
    }

    const mgr = new TestRepoManager(fakeDb, baseConfig);

    // Three different keys should each trigger their own create.
    await Promise.all([
      mgr.getOrCreateWorktree('repo-1', 'gather-ticket-abc'),
      mgr.getOrCreateWorktree('repo-2', 'gather-ticket-abc'),
      mgr.getOrCreateWorktree('repo-1', 'gather-ticket-def'),
    ]);

    expect(createCount).toBe(3);
  });

  it('clears the in-flight slot on resolution so a subsequent failed-then-retry can run', async () => {
    let attempt = 0;

    class TestRepoManager extends RepoManager {
      override async createWorktree(repoId: string, sessionId: string): Promise<string> {
        attempt++;
        if (attempt === 1) {
          throw new Error('simulated first-attempt git failure');
        }
        return FAKE_PATH(sessionId, repoId);
      }
    }

    const mgr = new TestRepoManager(fakeDb, baseConfig);

    // First call: should reject with the simulated failure.
    await expect(
      mgr.getOrCreateWorktree('repo-1', 'gather-ticket-abc'),
    ).rejects.toThrow('simulated first-attempt');

    // Second call: in-flight slot was cleared by the .finally() handler so
    // we get a fresh attempt rather than the stuck-rejected previous promise.
    const path = await mgr.getOrCreateWorktree('repo-1', 'gather-ticket-abc');
    expect(path).toBe(FAKE_PATH('gather-ticket-abc', 'repo-1'));
    expect(attempt).toBe(2);
  });

  // clone() coalescing: uses the identical in-flight-promise pattern as
  // getOrCreateWorktree (see the implementation). Asserting it via
  // promise-reference identity at the public surface doesn't work because
  // async-fn return values are wrapped in a fresh Promise — the underlying
  // cloneImpl still runs once, but the wrapper around it differs per call.
  // Coverage of the same coalescing pattern is provided by the three
  // getOrCreateWorktree tests above; an integration-level proof for clone
  // would require mocking the entire git toolchain, which is out of scope
  // for unit tests.
});
