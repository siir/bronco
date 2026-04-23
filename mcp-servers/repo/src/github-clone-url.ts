import type { PrismaClient } from '@bronco/db';
import type { GithubCredentials } from '@bronco/shared-types';
import { IntegrationType } from '@bronco/shared-types';
import { createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';

const logger = createLogger('mcp-repo-github-clone-url');

/**
 * Resolution order for a repo clone URL:
 * 1. If the repo has `githubIntegrationId` set, use that integration's creds.
 * 2. Else, fall back to the platform-scoped GITHUB integration (clientId IS NULL).
 * 3. Else, leave the URL untouched (caller will use legacy SSH / unauth path).
 *
 * For `github_app` kind credentials, we currently log a TODO and fall through
 * to the next level — JWT → installation token minting is tracked as a
 * follow-up. Do not block clones on that for v1.
 */
export async function resolveCloneUrl(
  db: PrismaClient,
  encryptionKey: string,
  repo: { id: string; repoUrl: string; githubIntegrationId: string | null; clientId: string },
): Promise<string> {
  // Only apply token rewriting to HTTPS URLs. Plain HTTP URLs must be left
  // untouched so credentials are never embedded into a clone URL that would be
  // sent over an unencrypted connection. SSH URLs ("git@github.com:owner/repo.git")
  // are also left alone and will clone via the legacy SSH-key path if one is mounted.
  if (!repo.repoUrl.startsWith('https://')) {
    return repo.repoUrl;
  }

  // 1. Repo-level integration
  if (repo.githubIntegrationId) {
    const direct = await db.clientIntegration.findUnique({
      where: { id: repo.githubIntegrationId },
      select: { id: true, type: true, config: true, isActive: true, clientId: true },
    });
    // Guard against cross-tenant credential use: only use an integration if it is
    // platform-scoped (clientId IS NULL) or belongs to the same client as the repo.
    const matchesClient = direct ? direct.clientId === null || direct.clientId === repo.clientId : false;
    if (direct && direct.isActive && direct.type === IntegrationType.GITHUB && matchesClient) {
      const rewritten = applyCredentialsToUrl(repo.repoUrl, direct.config, encryptionKey, { repoId: repo.id, source: 'repo' });
      if (rewritten) return rewritten;
    } else if (direct && !matchesClient) {
      logger.warn(
        {
          repoId: repo.id,
          repoClientId: repo.clientId,
          integrationId: direct.id,
          integrationClientId: direct.clientId,
        },
        'Repo has githubIntegrationId for a different client — falling back to platform default',
      );
    } else if (direct) {
      logger.warn(
        { repoId: repo.id, integrationId: direct.id, type: direct.type, active: direct.isActive },
        'Repo has githubIntegrationId but integration is inactive or wrong type — falling back to platform default',
      );
    }
  }

  // 2. Platform-scoped GITHUB integration — prefer the "default" label so
  //    selection is deterministic when multiple platform-scoped rows exist.
  const platform = await db.clientIntegration.findFirst({
    where: { type: IntegrationType.GITHUB, clientId: null, isActive: true, label: 'default' },
    select: { id: true, config: true },
  });
  if (platform) {
    const rewritten = applyCredentialsToUrl(repo.repoUrl, platform.config, encryptionKey, { repoId: repo.id, source: 'platform' });
    if (rewritten) return rewritten;
  }

  // 3. Legacy fallback — unchanged URL. Caller's environment must provide SSH
  // keys or public access for this to succeed.
  return repo.repoUrl;
}

/**
 * Given an HTTPS repo URL and a GITHUB integration config, return a
 * token-embedded URL suitable for `git clone`.
 *
 * Returns null if the credential shape is unsupported (e.g. github_app for
 * v1) so the caller can fall through to the next resolution level.
 */
function applyCredentialsToUrl(
  repoUrl: string,
  rawConfig: unknown,
  encryptionKey: string,
  ctx: { repoId: string; source: 'repo' | 'platform' },
): string | null {
  const creds = parseCredentials(rawConfig);
  if (!creds) {
    logger.warn({ ...ctx }, 'GITHUB integration config malformed — skipping');
    return null;
  }

  if (creds.kind === 'github_app') {
    // TODO(#368-followup): mint a short-lived installation token from the
    // GitHub App JWT, then rewrite the URL with it. For v1 we log and fall
    // through so the next resolution level (platform default / SSH) can run.
    logger.warn(
      { ...ctx, appId: creds.appId, installationId: creds.installationId },
      'GITHUB integration uses github_app kind but token-minting is not yet implemented — falling through',
    );
    return null;
  }

  let token: string;
  try {
    token = looksEncrypted(creds.encryptedToken)
      ? decrypt(creds.encryptedToken, encryptionKey)
      : creds.encryptedToken;
  } catch (err) {
    logger.error({ ...ctx, err: err instanceof Error ? err.message : String(err) }, 'Failed to decrypt GITHUB PAT');
    return null;
  }
  if (!token) return null;

  // Parse the URL so we can reliably swap auth + host. URL mutation is safer
  // than string concatenation (handles subpaths under GHES, trailing .git, etc.).
  try {
    const parsed = new URL(repoUrl);
    parsed.username = 'x-access-token';
    parsed.password = token;
    // Only override host if the integration specifies one. Leaving the URL's
    // original host alone by default keeps github.com repos clone-compatible
    // when a GHES-scoped integration is also present.
    if (creds.host && creds.host !== parsed.host) {
      logger.debug(
        { ...ctx, urlHost: parsed.host, credHost: creds.host },
        'GITHUB integration host does not match repo URL host — leaving URL host unchanged',
      );
    }
    return parsed.toString();
  } catch (err) {
    logger.warn({ ...ctx, err: err instanceof Error ? err.message : String(err) }, 'Repo URL failed to parse — using raw URL');
    return null;
  }
}

function parseCredentials(raw: unknown): GithubCredentials | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === 'pat' && typeof obj.encryptedToken === 'string' && obj.encryptedToken.length > 0) {
    return {
      kind: 'pat',
      encryptedToken: obj.encryptedToken,
      host: typeof obj.host === 'string' ? obj.host : undefined,
    };
  }
  if (
    kind === 'github_app' &&
    typeof obj.appId === 'string' &&
    typeof obj.installationId === 'string' &&
    typeof obj.encryptedPrivateKey === 'string' &&
    obj.encryptedPrivateKey.length > 0
  ) {
    return {
      kind: 'github_app',
      appId: obj.appId,
      installationId: obj.installationId,
      encryptedPrivateKey: obj.encryptedPrivateKey,
      host: typeof obj.host === 'string' ? obj.host : undefined,
    };
  }
  return null;
}
