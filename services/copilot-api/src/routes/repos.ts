import type { FastifyInstance } from 'fastify';
import { IntegrationType, PROTECTED_BRANCH_NAMES } from '@bronco/shared-types';

class BranchPrefixError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BranchPrefixError';
  }
}

function validateBranchPrefix(prefix: string | undefined): void {
  if (prefix === undefined) return; // will use Prisma default
  const trimmed = prefix.trim();
  if (trimmed.length === 0) {
    throw new BranchPrefixError('branchPrefix must not be empty');
  }
  // Check the prefix itself and its first path segment against protected names
  const firstSegment = trimmed.split('/')[0];
  if (PROTECTED_BRANCH_NAMES.has(trimmed.toLowerCase()) || PROTECTED_BRANCH_NAMES.has(firstSegment.toLowerCase())) {
    throw new BranchPrefixError(
      `branchPrefix "${prefix}" conflicts with a protected branch name. Use a unique prefix like "claude" or "bot".`,
    );
  }
}

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

/**
 * Validate that a provided githubIntegrationId refers to a GITHUB-type
 * ClientIntegration and that its scope is compatible with the repo's client
 * (either the same client, or platform-scoped / clientId IS NULL).
 *
 * Returns an error message (caller should respond with 400) or null on success.
 */
async function validateGithubIntegration(
  fastify: FastifyInstance,
  githubIntegrationId: string,
  repoClientId: string,
): Promise<string | null> {
  const integ = await fastify.db.clientIntegration.findUnique({
    where: { id: githubIntegrationId },
    select: { type: true, clientId: true },
  });
  if (!integ) return 'Referenced githubIntegrationId not found';
  if (integ.type !== IntegrationType.GITHUB) {
    return `githubIntegrationId must reference a GITHUB integration (got ${integ.type})`;
  }
  // Allow client-scoped match, or platform-scoped (null clientId).
  if (integ.clientId !== null && integ.clientId !== repoClientId) {
    return 'githubIntegrationId belongs to a different client';
  }
  return null;
}

export async function repoRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/repos',
    async (request) => {
      const { clientId } = request.query;
      return fastify.db.codeRepo.findMany({
        where: {
          ...(clientId && { clientId }),
        },
        include: {
          client: { select: { name: true, shortCode: true } },
          _count: { select: { issueJobs: true } },
        },
        orderBy: { name: 'asc' },
      });
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/repos/:id', async (request) => {
    const repo = await fastify.db.codeRepo.findUnique({
      where: { id: request.params.id },
      include: {
        client: { select: { name: true, shortCode: true } },
        issueJobs: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });
    if (!repo) return fastify.httpErrors.notFound('Code repo not found');
    return repo;
  });

  fastify.post<{
    Body: {
      clientId: string;
      name: string;
      repoUrl: string;
      description?: string;
      defaultBranch?: string;
      branchPrefix?: string;
      environmentId?: string | null;
      githubIntegrationId?: string | null;
    };
  }>('/api/repos', async (request, reply) => {
    validateBranchPrefix(request.body.branchPrefix);

    const { clientId, environmentId, githubIntegrationId } = request.body;
    if (environmentId !== undefined && environmentId !== null) {
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
    }

    if (githubIntegrationId) {
      const err = await validateGithubIntegration(fastify, githubIntegrationId, clientId);
      if (err) return fastify.httpErrors.badRequest(err);
    }

    try {
      const repo = await fastify.db.codeRepo.create({
        data: request.body,
      });
      reply.code(201);
      return repo;
    } catch (err) {
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.badRequest('Invalid clientId — client does not exist');
      }
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A repo with this URL already exists for this client');
      }
      throw err;
    }
  });

  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      repoUrl?: string;
      description?: string;
      defaultBranch?: string;
      branchPrefix?: string;
      environmentId?: string | null;
      githubIntegrationId?: string | null;
      isActive?: boolean;
    };
  }>('/api/repos/:id', async (request) => {
    validateBranchPrefix(request.body.branchPrefix);

    const needsExistingRepo =
      (request.body.environmentId !== undefined && request.body.environmentId !== null) ||
      (request.body.githubIntegrationId !== undefined && request.body.githubIntegrationId !== null);

    let existingRepoClientId: string | undefined;
    if (needsExistingRepo) {
      const repo = await fastify.db.codeRepo.findUnique({
        where: { id: request.params.id },
        select: { clientId: true },
      });
      if (!repo) return fastify.httpErrors.notFound('Code repo not found');
      existingRepoClientId = repo.clientId;
    }

    if (request.body.environmentId !== undefined && request.body.environmentId !== null) {
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: request.body.environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== existingRepoClientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
    }

    if (request.body.githubIntegrationId !== undefined && request.body.githubIntegrationId !== null && existingRepoClientId) {
      const err = await validateGithubIntegration(fastify, request.body.githubIntegrationId, existingRepoClientId);
      if (err) return fastify.httpErrors.badRequest(err);
    }

    try {
      return await fastify.db.codeRepo.update({
        where: { id: request.params.id },
        data: request.body,
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Code repo not found');
      }
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/repos/:id', async (request, reply) => {
    // Check for related issue jobs before deleting
    const jobCount = await fastify.db.issueJob.count({
      where: { repoId: request.params.id },
    });
    if (jobCount > 0) {
      return fastify.httpErrors.conflict(
        `Cannot delete repo with ${jobCount} associated issue job(s). ` +
        'Deactivate the repo instead via PATCH with { isActive: false }.',
      );
    }

    await fastify.db.codeRepo.delete({
      where: { id: request.params.id },
    });
    reply.code(204);
  });
}
