import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { PROTECTED_BRANCH_NAMES, SufficiencyStatus } from '@bronco/shared-types';
import { resolveClientScope, scopeToWhere } from '../plugins/client-scope.js';

/** Matches the payload shape expected by the issue-resolver worker. */
interface IssueResolvePayload {
  issueJobId: string;
  resume?: boolean;
  regenerateFeedback?: string;
}

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

      // Scope enforcement: filter jobs to only those whose ticket belongs to the caller's client(s)
      const scope = await resolveClientScope(request);
      const clientScopeWhere = scopeToWhere(scope);
      // IssueJob has no direct clientId; scope via the ticket relation
      const ticketClientWhere =
        Object.keys(clientScopeWhere).length > 0
          ? { ticket: { clientId: clientScopeWhere.clientId as string | { in: string[] } } }
          : {};

      return fastify.db.issueJob.findMany({
        where: {
          ...ticketClientWhere,
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
    const scope = await resolveClientScope(request);
    const clientScopeWhere = scopeToWhere(scope);
    const ticketClientWhere =
      Object.keys(clientScopeWhere).length > 0
        ? { ticket: { clientId: clientScopeWhere.clientId as string | { in: string[] } } }
        : {};

    const job = await fastify.db.issueJob.findFirst({
      where: { id: request.params.id, ...ticketClientWhere },
      include: {
        ticket: { select: { subject: true, description: true, category: true, clientId: true } },
        repo: { select: { name: true, repoUrl: true, branchPrefix: true, defaultBranch: true } },
      },
    });
    if (!job) return fastify.httpErrors.notFound('Issue job not found');
    return job;
  });

  // Get the plan for an issue job
  fastify.get<{ Params: { id: string } }>('/api/issue-jobs/:id/plan', async (request) => {
    const scope = await resolveClientScope(request);
    const clientScopeWhere = scopeToWhere(scope);
    const ticketClientWhere =
      Object.keys(clientScopeWhere).length > 0
        ? { ticket: { clientId: clientScopeWhere.clientId as string | { in: string[] } } }
        : {};

    const job = await fastify.db.issueJob.findFirst({
      where: { id: request.params.id, ...ticketClientWhere },
      select: {
        id: true,
        status: true,
        plan: true,
        planRevision: true,
        planFeedback: true,
        approvedAt: true,
        approvedBy: true,
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
    Querystring: {
      force?: string;
    };
  }>('/api/issue-jobs', async (request, reply) => {
    const { ticketId, repoId } = request.body;
    const force = request.query.force === 'true';

    // Validate ticket exists
    const ticket = await fastify.db.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, subject: true, description: true, category: true, clientId: true, sufficiencyStatus: true },
    });
    if (!ticket) return fastify.httpErrors.notFound('Ticket not found');

    // Scope enforcement: validate the caller is authorized for the ticket's client
    const scope = await resolveClientScope(request);
    if (
      (scope.type === 'single' && scope.clientId !== ticket.clientId) ||
      (scope.type === 'assigned' && !scope.clientIds.includes(ticket.clientId))
    ) {
      return fastify.httpErrors.forbidden('clientId not in your scope');
    }

    // Sufficiency gate
    if (!force) {
      const suffStatus = ticket.sufficiencyStatus as string | null;
      if (suffStatus === SufficiencyStatus.NEEDS_USER_INPUT || suffStatus === SufficiencyStatus.INSUFFICIENT) {
        return fastify.httpErrors.badRequest(
          `Ticket sufficiency is "${suffStatus}" — resolve outstanding questions before triggering resolution. Use ?force=true to bypass.`,
        );
      }
    }

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
    } satisfies IssueResolvePayload);

    reply.code(201);
    return issueJob;
  });

  // Approve an issue job plan — resumes execution
  fastify.post<{
    Params: { id: string };
    Body: {
      approvedBy?: string;
      operatorId?: string;
    };
  }>('/api/issue-jobs/:id/approve', async (request) => {
    const scope = await resolveClientScope(request);
    const clientScopeWhere = scopeToWhere(scope);
    const ticketClientWhere =
      Object.keys(clientScopeWhere).length > 0
        ? { ticket: { clientId: clientScopeWhere.clientId as string | { in: string[] } } }
        : {};

    const job = await fastify.db.issueJob.findFirst({
      where: { id: request.params.id, ...ticketClientWhere },
      select: { id: true, status: true, plan: true, ticketId: true },
    });
    if (!job) return fastify.httpErrors.notFound('Issue job not found');
    if (job.status !== 'AWAITING_APPROVAL') {
      return fastify.httpErrors.badRequest(`Cannot approve job in status "${job.status}" — must be AWAITING_APPROVAL`);
    }
    if (!job.plan) {
      return fastify.httpErrors.badRequest('Cannot approve job without a plan');
    }

    // Resolve operator identity for approval audit trail
    const operatorId = request.body?.operatorId;
    let approvedBy = request.body?.approvedBy ?? 'operator';
    let approvedByOperatorId: string | null = null;

    if (operatorId) {
      const operator = await fastify.db.operator.findUnique({
        where: { id: operatorId },
        select: { id: true, person: { select: { name: true, isActive: true } } },
      });
      if (!operator || !operator.person.isActive) {
        return fastify.httpErrors.badRequest('operatorId is invalid or refers to an inactive operator');
      }
      approvedByOperatorId = operator.id;
      approvedBy = operator.person.name;
    }

    // Atomic transition out of AWAITING_APPROVAL to prevent duplicate approvals
    const updated = await fastify.db.issueJob.updateMany({
      where: { id: request.params.id, status: 'AWAITING_APPROVAL' },
      data: {
        status: 'CLONING',
        approvedAt: new Date(),
        approvedBy,
        approvedByOperatorId,
      },
    });
    if (updated.count === 0) {
      return fastify.httpErrors.conflict('Job is no longer in AWAITING_APPROVAL — it may have already been approved or rejected');
    }

    // Create audit event for the approval
    await fastify.db.ticketEvent.create({
      data: {
        ticketId: job.ticketId,
        eventType: 'PLAN_APPROVED',
        content: `Plan approved by ${approvedBy}`,
        metadata: {
          issueJobId: request.params.id,
          approvedBy,
          approvedByOperatorId,
        },
        actor: approvedBy,
      },
    });

    // Enqueue a resume job with deterministic ID to prevent duplicates
    await issueResolveQueue.add('resolve-issue', {
      issueJobId: request.params.id,
      resume: true,
    } satisfies IssueResolvePayload, {
      jobId: `resume-${request.params.id}`,
    });

    return { id: request.params.id, status: 'CLONING', message: 'Plan approved — execution queued' };
  });

  // Reject an issue job plan — triggers plan regeneration with feedback
  fastify.post<{
    Params: { id: string };
    Body: {
      feedback: string;
    };
  }>('/api/issue-jobs/:id/reject', async (request) => {
    const scope = await resolveClientScope(request);
    const clientScopeWhere = scopeToWhere(scope);
    const ticketClientWhere =
      Object.keys(clientScopeWhere).length > 0
        ? { ticket: { clientId: clientScopeWhere.clientId as string | { in: string[] } } }
        : {};

    const job = await fastify.db.issueJob.findFirst({
      where: { id: request.params.id, ...ticketClientWhere },
      select: { id: true, status: true, plan: true },
    });
    if (!job) return fastify.httpErrors.notFound('Issue job not found');
    if (job.status !== 'AWAITING_APPROVAL') {
      return fastify.httpErrors.badRequest(`Cannot reject job in status "${job.status}" — must be AWAITING_APPROVAL`);
    }

    if (!job.plan) {
      return fastify.httpErrors.badRequest('Cannot reject job without a plan');
    }

    const feedback = request.body?.feedback;
    if (!feedback || typeof feedback !== 'string' || feedback.trim().length === 0) {
      return fastify.httpErrors.badRequest('Feedback is required when rejecting a plan');
    }

    // Atomic transition to PLANNING and clear stale approval metadata
    await fastify.db.issueJob.updateMany({
      where: { id: request.params.id, status: 'AWAITING_APPROVAL' },
      data: {
        status: 'PLANNING',
        approvedAt: null,
        approvedBy: null,
      },
    });

    // Enqueue a regeneration job
    await issueResolveQueue.add('resolve-issue', {
      issueJobId: request.params.id,
      regenerateFeedback: feedback.trim(),
    } satisfies IssueResolvePayload);

    return { id: request.params.id, status: 'PLANNING', message: 'Plan rejected — regeneration queued with feedback' };
  });
}
