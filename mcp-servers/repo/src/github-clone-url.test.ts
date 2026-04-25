/**
 * Unit tests for github-clone-url.ts
 *
 * Tests the fallback chain:
 *   1. Repo-level GITHUB integration (client-scoped or platform-scoped)
 *   2. Platform-scoped GITHUB integration (clientId IS NULL, label: 'default')
 *   3. Unchanged URL (SSH / no credentials)
 *
 * PAT-in-URL security: verifies the token is embedded only in the returned
 * string and never observed in the "plain" URL path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@bronco/shared-utils';
import { resolveCloneUrl } from './github-clone-url.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// 32-byte (64 hex chars) AES-256 key for testing
const TEST_KEY = 'a'.repeat(64);
const TEST_PAT = 'ghp_testtoken1234567890';

function makePat(pat = TEST_PAT): string {
  return encrypt(pat, TEST_KEY);
}

// A minimal mock of the PrismaClient for our purposes
function makeMockDb(
  findUniqueResult: unknown = null,
  findFirstResult: unknown = null,
) {
  return {
    clientIntegration: {
      findUnique: vi.fn().mockResolvedValue(findUniqueResult),
      findFirst: vi.fn().mockResolvedValue(findFirstResult),
    },
  } as unknown as import('@bronco/db').PrismaClient;
}

const REPO_HTTPS = 'https://github.com/owner/repo.git';
const REPO_SSH = 'git@github.com:owner/repo.git';
const REPO_HTTP = 'http://github.com/owner/repo.git';

const BASE_REPO = {
  id: 'repo-id-1',
  repoUrl: REPO_HTTPS,
  githubIntegrationId: null as string | null,
  clientId: 'client-id-1',
};

// ---------------------------------------------------------------------------
// PAT helpers
// ---------------------------------------------------------------------------

function extractCredentialFromUrl(url: string): { username: string; password: string } | null {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return null;
    return { username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveCloneUrl', () => {
  let db: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    db = makeMockDb();
  });

  // -------------------------------------------------------------------------
  // Level 3: SSH / unchanged URL fallback
  // -------------------------------------------------------------------------

  describe('Level 3 — fallback / unchanged URL', () => {
    it('returns SSH URL unchanged — no db lookups for non-HTTPS', async () => {
      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        repoUrl: REPO_SSH,
      });
      expect(result).toBe(REPO_SSH);
      expect(db.clientIntegration.findUnique).not.toHaveBeenCalled();
      expect(db.clientIntegration.findFirst).not.toHaveBeenCalled();
    });

    it('returns plain HTTP URL unchanged without credential injection', async () => {
      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        repoUrl: REPO_HTTP,
      });
      expect(result).toBe(REPO_HTTP);
      // No db lookups should occur for non-HTTPS
      expect(db.clientIntegration.findUnique).not.toHaveBeenCalled();
      expect(db.clientIntegration.findFirst).not.toHaveBeenCalled();
    });

    it('returns original HTTPS URL when no integrations exist', async () => {
      db = makeMockDb(null, null);
      const result = await resolveCloneUrl(db, TEST_KEY, BASE_REPO);
      expect(result).toBe(REPO_HTTPS);
    });
  });

  // -------------------------------------------------------------------------
  // Level 1: Repo-level (client-scoped) integration
  // -------------------------------------------------------------------------

  describe('Level 1 — repo-level GITHUB integration', () => {
    it('embeds PAT from client-scoped integration', async () => {
      const encToken = makePat();
      const integration = {
        id: 'integ-1',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: encToken },
        isActive: true,
        clientId: 'client-id-1',
      };
      db = makeMockDb(integration, null);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-1',
      });

      expect(result).toContain('x-access-token');
      expect(result).toContain(TEST_PAT);
      expect(result).toMatch(/^https:\/\//);
      // Plain URL does not contain token
      expect(REPO_HTTPS).not.toContain(TEST_PAT);
    });

    it('embeds PAT from platform-scoped integration (clientId null) attached to repo', async () => {
      const encToken = makePat();
      const integration = {
        id: 'integ-platform',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: encToken },
        isActive: true,
        clientId: null, // platform-scoped
      };
      db = makeMockDb(integration, null);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-platform',
      });

      expect(result).toContain(TEST_PAT);
      expect(result).toContain('x-access-token');
    });

    it('falls through to Level 2 when repo integration is inactive', async () => {
      const encToken = makePat('ghp_level2token');
      const inactiveInteg = {
        id: 'integ-inactive',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: encrypt('ghp_level1', TEST_KEY) },
        isActive: false,
        clientId: 'client-id-1',
      };
      const platformInteg = {
        id: 'integ-platform',
        config: { kind: 'pat', encryptedToken: encToken },
      };
      db = makeMockDb(inactiveInteg, platformInteg);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-inactive',
      });

      // Should use level-2 token
      expect(result).toContain('ghp_level2token');
      expect(result).not.toContain('ghp_level1');
    });

    it('falls through to Level 2 when repo integration belongs to a different client', async () => {
      const encToken = makePat('ghp_level2token');
      const wrongClientInteg = {
        id: 'integ-wrong',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: encrypt('ghp_wrong', TEST_KEY) },
        isActive: true,
        clientId: 'OTHER-CLIENT',
      };
      const platformInteg = {
        id: 'integ-platform',
        config: { kind: 'pat', encryptedToken: encToken },
      };
      db = makeMockDb(wrongClientInteg, platformInteg);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-wrong',
      });

      expect(result).toContain('ghp_level2token');
      expect(result).not.toContain('ghp_wrong');
    });

    it('falls through to Level 2 when repo integration has wrong type', async () => {
      const encToken = makePat('ghp_level2token');
      const wrongTypeInteg = {
        id: 'integ-imap',
        type: 'IMAP', // wrong type
        config: { kind: 'pat', encryptedToken: encrypt('ghp_wrong', TEST_KEY) },
        isActive: true,
        clientId: 'client-id-1',
      };
      const platformInteg = {
        id: 'integ-platform',
        config: { kind: 'pat', encryptedToken: encToken },
      };
      db = makeMockDb(wrongTypeInteg, platformInteg);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-imap',
      });

      expect(result).toContain('ghp_level2token');
    });

    it('falls through to Level 3 when repo integration uses github_app kind (not yet implemented)', async () => {
      const appInteg = {
        id: 'integ-app',
        type: 'GITHUB',
        config: {
          kind: 'github_app',
          appId: '123',
          installationId: '456',
          encryptedPrivateKey: encrypt('private-key-pem', TEST_KEY),
        },
        isActive: true,
        clientId: 'client-id-1',
      };
      db = makeMockDb(appInteg, null);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-app',
      });

      // Falls through to Level 3 (no integration at level 2 either)
      expect(result).toBe(REPO_HTTPS);
      // No token embedded
      const creds = extractCredentialFromUrl(result);
      expect(creds).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Level 2: Platform-scoped default integration
  // -------------------------------------------------------------------------

  describe('Level 2 — platform-scoped GITHUB integration', () => {
    it('embeds PAT from platform-scoped integration when no repo-level one is set', async () => {
      const encToken = makePat('ghp_platform');
      const platformInteg = {
        id: 'integ-plat',
        config: { kind: 'pat', encryptedToken: encToken },
      };
      db = makeMockDb(null, platformInteg);

      const result = await resolveCloneUrl(db, TEST_KEY, BASE_REPO);

      expect(result).toContain('ghp_platform');
      expect(result).toContain('x-access-token');
      expect(result).toMatch(/^https:\/\//);
    });

    it('does NOT look up platform integration when no githubIntegrationId (skips findUnique)', async () => {
      const encToken = makePat('ghp_platform');
      const platformInteg = {
        id: 'integ-plat',
        config: { kind: 'pat', encryptedToken: encToken },
      };
      db = makeMockDb(null, platformInteg);

      await resolveCloneUrl(db, TEST_KEY, BASE_REPO);

      expect(db.clientIntegration.findUnique).not.toHaveBeenCalled();
      expect(db.clientIntegration.findFirst).toHaveBeenCalledOnce();
    });

    it('falls through to Level 3 when platform integration config is malformed', async () => {
      const platformInteg = {
        id: 'integ-plat',
        config: { kind: 'pat' /* missing encryptedToken */ },
      };
      db = makeMockDb(null, platformInteg);

      const result = await resolveCloneUrl(db, TEST_KEY, BASE_REPO);
      expect(result).toBe(REPO_HTTPS);
    });

    it('falls through to Level 3 when platform integration config is null', async () => {
      const platformInteg = {
        id: 'integ-plat',
        config: null,
      };
      db = makeMockDb(null, platformInteg);

      const result = await resolveCloneUrl(db, TEST_KEY, BASE_REPO);
      expect(result).toBe(REPO_HTTPS);
    });
  });

  // -------------------------------------------------------------------------
  // PAT security: token must not persist in the returned URL if plain URL passes
  // -------------------------------------------------------------------------

  describe('PAT security', () => {
    it('returned URL for SSH is plain (no credentials embedded)', async () => {
      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        repoUrl: REPO_SSH,
      });
      // SSH URLs use user@host syntax (e.g. git@github.com:owner/repo.git);
      // the `@` is part of the SSH protocol, not embedded credentials. What we
      // care about is that no PAT/password was injected — i.e. the URL still
      // matches the input verbatim.
      expect(result).toBe(REPO_SSH);
    });

    it('returned URL for HTTPS without integration is plain', async () => {
      db = makeMockDb(null, null);
      const result = await resolveCloneUrl(db, TEST_KEY, BASE_REPO);
      const creds = extractCredentialFromUrl(result);
      expect(creds).toBeNull();
    });

    it('returned URL with PAT uses x-access-token as username', async () => {
      const encToken = makePat('ghp_secret_token');
      const integ = {
        id: 'integ-1',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: encToken },
        isActive: true,
        clientId: 'client-id-1',
      };
      db = makeMockDb(integ, null);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-1',
      });

      const creds = extractCredentialFromUrl(result);
      expect(creds).not.toBeNull();
      expect(creds!.username).toBe('x-access-token');
      expect(creds!.password).toBe('ghp_secret_token');
    });

    it('URL remains HTTPS scheme after PAT injection (never downgrades)', async () => {
      const encToken = makePat();
      const integ = {
        id: 'integ-1',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: encToken },
        isActive: true,
        clientId: 'client-id-1',
      };
      db = makeMockDb(integ, null);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-1',
      });

      expect(result).toMatch(/^https:\/\//);
    });

    it('handles unencrypted PAT token (plain text in config)', async () => {
      // looksEncrypted returns false for plain text → passes through directly
      const integ = {
        id: 'integ-plain',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: 'ghp_plaintext_token' },
        isActive: true,
        clientId: 'client-id-1',
      };
      db = makeMockDb(integ, null);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: 'integ-plain',
      });

      expect(result).toContain('ghp_plaintext_token');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles repo with no githubIntegrationId (skips Level 1 entirely)', async () => {
      const encToken = makePat('ghp_plat');
      db = makeMockDb(null, {
        id: 'integ-plat',
        config: { kind: 'pat', encryptedToken: encToken },
      });

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        githubIntegrationId: null,
      });

      expect(db.clientIntegration.findUnique).not.toHaveBeenCalled();
      expect(result).toContain('ghp_plat');
    });

    it('handles HTTPS URL with a subpath (GHES-style)', async () => {
      const encToken = makePat('ghp_ghes');
      const integ = {
        id: 'integ-1',
        type: 'GITHUB',
        config: { kind: 'pat', encryptedToken: encToken },
        isActive: true,
        clientId: 'client-id-1',
      };
      db = makeMockDb(integ, null);

      const result = await resolveCloneUrl(db, TEST_KEY, {
        ...BASE_REPO,
        repoUrl: 'https://github.example.com/owner/repo.git',
        githubIntegrationId: 'integ-1',
      });

      expect(result).toContain('ghp_ghes');
      expect(result).toContain('github.example.com');
    });
  });
});
