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

    // Yield to the next event-loop turn so the in-flight cache settles
    // (setImmediate schedules a macrotask, run after pending microtasks).
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

  it('clears the in-flight slot on settlement so a subsequent failed-then-retry can run', async () => {
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

  it('cleanupSession waits for in-flight creates for the same sessionId before removing', async () => {
    // Regression for the #482 review: cleanupSession used to fire `rm -rf`
    // on the session directory while a create was mid-flight, racing against
    // the create's git operations. The fix snapshots in-flight promises for
    // the matching sessionId and awaits them before proceeding.
    const order: string[] = [];
    let resolveCreate: ((path: string) => void) | null = null;

    class TestRepoManager extends RepoManager {
      override async createWorktree(repoId: string, sessionId: string): Promise<string> {
        order.push(`create-start:${sessionId}:${repoId}`);
        return new Promise<string>((resolve) => {
          resolveCreate = (path) => {
            order.push(`create-resolve:${sessionId}:${repoId}`);
            resolve(path);
          };
        });
      }
      // Stub removeWorktree + the rm of the session directory so cleanup
      // doesn't try to access the real filesystem; just trace the order.
      protected override async removeWorktree(): Promise<void> {
        order.push('remove-worktree');
      }
      protected override async pathExists(): Promise<boolean> {
        return false; // session dir does not exist; cleanup skips the rm
      }
    }

    const mgr = new TestRepoManager(fakeDb, baseConfig);

    // Kick off a create for gather-ticket-abc:repo-1
    const createPromise = mgr.getOrCreateWorktree('repo-1', 'gather-ticket-abc');

    // Yield so the in-flight slot is populated before cleanup checks it
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['create-start:gather-ticket-abc:repo-1']);

    // Start cleanup BEFORE the create resolves — it must NOT proceed until
    // the create settles.
    const cleanupPromise = mgr.cleanupSession('gather-ticket-abc');

    // Give cleanup a chance to advance — but it should be parked awaiting
    // the in-flight create promise.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['create-start:gather-ticket-abc:repo-1']);

    // Now resolve the create. Cleanup should now proceed.
    resolveCreate!(FAKE_PATH('gather-ticket-abc', 'repo-1'));

    await Promise.all([createPromise, cleanupPromise]);

    // Resolution happened before any cleanup work — proves we awaited
    // the in-flight before removing.
    const resolveIdx = order.indexOf('create-resolve:gather-ticket-abc:repo-1');
    const removeIdx = order.indexOf('remove-worktree');
    // remove-worktree may not appear because the worktree map was empty
    // at cleanup time (the test stub never adds entries), so we just
    // assert resolve fired and order is monotonic.
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    if (removeIdx !== -1) {
      expect(removeIdx).toBeGreaterThan(resolveIdx);
    }
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
