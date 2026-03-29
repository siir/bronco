import type { FastifyInstance } from 'fastify';
import { PROTECTED_BRANCH_NAMES } from '@bronco/shared-types';

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
      defaultBranch?: string;
      branchPrefix?: string;
      environmentId?: string | null;
    };
  }>('/api/repos', async (request, reply) => {
    validateBranchPrefix(request.body.branchPrefix);

    const { clientId, environmentId } = request.body;
    if (environmentId !== undefined && environmentId !== null) {
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
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
      defaultBranch?: string;
      branchPrefix?: string;
      environmentId?: string | null;
      isActive?: boolean;
    };
  }>('/api/repos/:id', async (request) => {
    validateBranchPrefix(request.body.branchPrefix);

    if (request.body.environmentId !== undefined && request.body.environmentId !== null) {
      const repo = await fastify.db.codeRepo.findUnique({
        where: { id: request.params.id },
        select: { clientId: true },
      });
      if (!repo) return fastify.httpErrors.notFound('Code repo not found');
      const env = await fastify.db.clientEnvironment.findUnique({
        where: { id: request.body.environmentId },
        select: { clientId: true },
      });
      if (!env) return fastify.httpErrors.badRequest('Referenced environment not found');
      if (env.clientId !== repo.clientId) return fastify.httpErrors.forbidden('environmentId belongs to a different client');
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
