import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { PROTECTED_BRANCH_NAMES } from '@bronco/shared-types';

interface IssueJobRouteOpts {
  issueResolveQueue: Queue;
}

export async function issueJobRoutes(fastify: FastifyInstance, opts: IssueJobRouteOpts): Promise<void> {
  const { issueResolveQueue } = opts;

  // List issue jobs, optionally filtered by ticketId or repoId
  fastify.get<{ Querystring: { ticketId?: string; repoId?: string; status?: string; limit?: number; offset?: number } }>(
    '/api/issue-jobs',
    async (request) => {
      const { ticketId, repoId, status, limit = 50, offset = 0 } = request.query;
      return fastify.db.issueJob.findMany({
        where: {
          ...(ticketId && { ticketId }),
          ...(repoId && { repoId }),
          ...(status && { status: status as never }),
        },
        include: {
          ticket: { select: { subject: true, category: true } },
          repo: { select: { name: true, repoUrl: true, branchPrefix: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      });
    },
  );

  // Get a single issue job by ID
  fastify.get<{ Params: { id: string } }>('/api/issue-jobs/:id', async (request) => {
    const job = await fastify.db.issueJob.findUnique({
      where: { id: request.params.id },
      include: {
        ticket: { select: { subject: true, description: true, category: true, clientId: true } },
        repo: { select: { name: true, repoUrl: true, branchPrefix: true, defaultBranch: true } },
      },
    });
    if (!job) return fastify.httpErrors.notFound('Issue job not found');
    return job;
  });

  // Trigger automated issue resolution for a ticket against a repo
  fastify.post<{
    Body: {
      ticketId: string;
      repoId: string;
    };
  }>('/api/issue-jobs', async (request, reply) => {
    const { ticketId, repoId } = request.body;

    // Validate ticket exists
    const ticket = await fastify.db.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, subject: true, description: true, category: true, clientId: true },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');

    // Validate repo exists and belongs to same client
    const repo = await fastify.db.codeRepo.findUnique({
      where: { id: repoId },
      select: { id: true, clientId: true, branchPrefix: true, isActive: true },
    });
    if (!repo) return fastify.httpErrors.notFound('Code repo not found');
    if (repo.clientId !== ticket.clientId) {
      return fastify.httpErrors.badRequest('Repo and ticket must belong to the same client');
    }
    if (!repo.isActive) {
      return fastify.httpErrors.badRequest('Code repo is not active');
    }

    // Build branch name: {branchPrefix}/{sanitized-subject}
    const sanitized = ticket.subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);

    if (!sanitized) {
      return fastify.httpErrors.badRequest('Ticket subject produced an empty branch slug');
    }

    const branchName = `${repo.branchPrefix}/${sanitized}`;

    // Safety: never allow a job that would target a protected branch
    if (PROTECTED_BRANCH_NAMES.has(branchName.toLowerCase())) {
      return fastify.httpErrors.badRequest(
        `Generated branch name "${branchName}" collides with a protected branch`,
      );
    }

    // Create the issue job record
    const issueJob = await fastify.db.issueJob.create({
      data: {
        ticketId,
        repoId,
        branchName,
      },
    });

    // Enqueue the job for the issue-resolver worker
    await issueResolveQueue.add('resolve-issue', {
      issueJobId: issueJob.id,
    });

    reply.code(201);
    return issueJob;
  });
}
