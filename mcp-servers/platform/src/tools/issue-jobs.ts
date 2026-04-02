import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

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
    },
    async (params) => {
      const [ticket, repo] = await Promise.all([
        db.ticket.findUniqueOrThrow({ where: { id: params.ticketId }, select: { id: true, subject: true } }),
        db.codeRepo.findUniqueOrThrow({ where: { id: params.repoId }, select: { id: true, branchPrefix: true } }),
      ]);

      const slug = ticket.subject
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
      const branchName = `${repo.branchPrefix}/${slug}`;

      const job = await db.issueJob.create({
        data: {
          ticketId: params.ticketId,
          repoId: params.repoId,
          branchName,
          status: 'PENDING',
        },
      });

      await issueResolveQueue.add('resolve', { jobId: job.id });

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
      const job = await db.issueJob.update({
        where: { id: params.jobId },
        data: {
          status: 'APPLYING',
          approvedAt: new Date(),
          approvedBy: 'mcp:platform',
          ...(params.operatorId ? { approvedByOperatorId: params.operatorId } : {}),
        },
      });

      await issueResolveQueue.add('execute', { jobId: job.id });

      return { content: [{ type: 'text', text: JSON.stringify({ message: 'Plan approved and execution enqueued', jobId: job.id }, null, 2) }] };
    },
  );

  server.tool(
    'reject_plan',
    'Reject an issue resolution plan with feedback for regeneration.',
    {
      jobId: z.string().uuid().describe('The job ID'),
      feedback: z.string().describe('Feedback explaining why the plan was rejected'),
    },
    async (params) => {
      const job = await db.issueJob.update({
        where: { id: params.jobId },
        data: {
          status: 'PLANNING',
          planFeedback: params.feedback,
        },
      });

      await issueResolveQueue.add('replan', { jobId: job.id });

      return { content: [{ type: 'text', text: JSON.stringify({ message: 'Plan rejected with feedback, replanning enqueued', jobId: job.id }, null, 2) }] };
    },
  );
}
