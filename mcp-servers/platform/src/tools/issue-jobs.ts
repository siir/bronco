import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PROTECTED_BRANCH_NAMES, SufficiencyStatus } from '@bronco/shared-types';
import type { ServerDeps } from '../server.js';

/** Matches the payload shape expected by the issue-resolver worker. */
interface IssueResolvePayload {
  issueJobId: string;
  resume?: boolean;
  regenerateFeedback?: string;
}

export function registerIssueJobTools(server: McpServer, { db, issueResolveQueue }: ServerDeps): void {
  server.tool(
    'list_issue_jobs',
    'List issue resolution jobs with status and plan summary.',
    {
      ticketId: z.string().uuid().optional().describe('Filter by ticket ID'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.ticketId) where.ticketId = params.ticketId;

      const jobs = await db.issueJob.findMany({
        where,
        select: {
          id: true,
          status: true,
          branchName: true,
          planRevision: true,
          commitSha: true,
          filesChanged: true,
          aiModel: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          ticket: { select: { id: true, ticketNumber: true, subject: true } },
          repo: { select: { id: true, name: true, repoUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
    },
  );

  server.tool(
    'get_issue_job',
    'Get full issue resolution job detail with plan.',
    {
      jobId: z.string().uuid().describe('The job ID'),
    },
    async (params) => {
      const job = await db.issueJob.findUniqueOrThrow({
        where: { id: params.jobId },
        include: {
          ticket: { select: { id: true, ticketNumber: true, subject: true, description: true } },
          repo: { select: { id: true, name: true, repoUrl: true, defaultBranch: true } },
          approvedByOperator: { select: { id: true, name: true } },
        },
      });

      return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
    },
  );

  server.tool(
    'create_issue_job',
    'Create and enqueue a new issue resolution job for a ticket and repo.',
    {
      ticketId: z.string().uuid().describe('The ticket ID'),
      repoId: z.string().uuid().describe('The code repo ID'),
      force: z.boolean().optional().describe('Bypass sufficiency gate (default false)'),
    },
    async (params) => {
      const ticket = await db.ticket.findUniqueOrThrow({
        where: { id: params.ticketId },
        select: { id: true, subject: true, clientId: true, sufficiencyStatus: true },
      });

      // Sufficiency gate
      if (!params.force) {
        const suffStatus = ticket.sufficiencyStatus as string | null;
        if (suffStatus === SufficiencyStatus.NEEDS_USER_INPUT || suffStatus === SufficiencyStatus.INSUFFICIENT) {
          throw new Error(
            `Ticket sufficiency is "${suffStatus}" — resolve outstanding questions before triggering resolution. Set force=true to bypass.`,
          );
        }
      }

      const repo = await db.codeRepo.findUniqueOrThrow({
        where: { id: params.repoId },
        select: { id: true, clientId: true, branchPrefix: true, isActive: true },
      });

      // Repo must belong to same client as ticket
      if (repo.clientId !== ticket.clientId) {
        throw new Error('Repo and ticket must belong to the same client');
      }

      // Repo must be active
      if (!repo.isActive) {
        throw new Error('Code repo is not active');
      }

      const slug = ticket.subject
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);

      if (!slug) {
        throw new Error('Ticket subject produced an empty branch slug');
      }

      const branchName = `${repo.branchPrefix}/${slug}`;

      // Branch safety: never target a protected branch
      if (PROTECTED_BRANCH_NAMES.has(branchName.toLowerCase())) {
        throw new Error(`Generated branch name "${branchName}" collides with a protected branch`);
      }

      const job = await db.issueJob.create({
        data: {
          ticketId: params.ticketId,
          repoId: params.repoId,
          branchName,
          status: 'PENDING',
        },
      });

      await issueResolveQueue.add('resolve-issue', {
        issueJobId: job.id,
      } satisfies IssueResolvePayload);

      return { content: [{ type: 'text', text: JSON.stringify(job, null, 2) }] };
    },
  );

  server.tool(
    'approve_plan',
    'Approve an issue resolution plan for execution.',
    {
      jobId: z.string().uuid().describe('The job ID'),
      operatorId: z.string().uuid().optional().describe('The approving operator ID'),
    },
    async (params) => {
      const existing = await db.issueJob.findUniqueOrThrow({
        where: { id: params.jobId },
        select: { id: true, status: true, plan: true },
      });
      if (existing.status !== 'AWAITING_APPROVAL') {
        throw new Error(`Cannot approve job in status "${existing.status}" — must be AWAITING_APPROVAL`);
      }
      if (!existing.plan) {
        throw new Error('Cannot approve job without a plan');
      }

      let approvedByOperatorId: string | null = null;
      if (params.operatorId) {
        const operator = await db.operator.findUnique({
          where: { id: params.operatorId },
          select: { id: true, isActive: true },
        });
        if (!operator || !operator.isActive) {
          throw new Error('operatorId is invalid or refers to an inactive operator');
        }
        approvedByOperatorId = operator.id;
      }

      // Atomic transition out of AWAITING_APPROVAL to prevent duplicate approvals
      const updated = await db.issueJob.updateMany({
        where: { id: params.jobId, status: 'AWAITING_APPROVAL' },
        data: {
          status: 'CLONING',
          approvedAt: new Date(),
          approvedBy: 'mcp:platform',
          approvedByOperatorId,
        },
      });
      if (updated.count === 0) {
        throw new Error('Job is no longer in AWAITING_APPROVAL — it may have already been approved or rejected');
      }

      await issueResolveQueue.add('resolve-issue', {
        issueJobId: params.jobId,
        resume: true,
      } satisfies IssueResolvePayload, {
        jobId: `resume-${params.jobId}`,
      });

      return { content: [{ type: 'text', text: JSON.stringify({ message: 'Plan approved and execution enqueued', jobId: params.jobId }, null, 2) }] };
    },
  );

  server.tool(
    'reject_plan',
    'Reject an issue resolution plan with feedback for regeneration.',
    {
      jobId: z.string().uuid().describe('The job ID'),
      feedback: z.string().min(1).describe('Feedback explaining why the plan was rejected'),
    },
    async (params) => {
      const existing = await db.issueJob.findUniqueOrThrow({
        where: { id: params.jobId },
        select: { id: true, status: true, plan: true },
      });
      if (existing.status !== 'AWAITING_APPROVAL') {
        throw new Error(`Cannot reject job in status "${existing.status}" — must be AWAITING_APPROVAL`);
      }
      if (!existing.plan) {
        throw new Error('Cannot reject job without a plan');
      }

      // Atomic transition to PLANNING
      await db.issueJob.updateMany({
        where: { id: params.jobId, status: 'AWAITING_APPROVAL' },
        data: {
          status: 'PLANNING',
          planFeedback: params.feedback.trim(),
          approvedAt: null,
          approvedBy: null,
        },
      });

      await issueResolveQueue.add('resolve-issue', {
        issueJobId: params.jobId,
        regenerateFeedback: params.feedback.trim(),
      } satisfies IssueResolvePayload);

      return { content: [{ type: 'text', text: JSON.stringify({ message: 'Plan rejected with feedback, replanning enqueued', jobId: params.jobId }, null, 2) }] };
    },
  );
}
