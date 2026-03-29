import type { Job } from 'bullmq';
import { type PrismaClient, getDb } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import { createLogger, AppLogger, createPrismaLogWriter } from '@bronco/shared-utils';
import type { Config } from './config.js';
import { prepareRepo, commitAndPush } from './git.js';
import { resolveIssue, applyChanges } from './resolver.js';

const logger = createLogger('issue-resolver:worker');
const appLog = new AppLogger('issue-resolver');

export function initWorkerLogger(db: PrismaClient): void {
  appLog.setWriter(createPrismaLogWriter(db));
}

interface IssueResolvePayload {
  issueJobId: string;
}

async function updateJobStatus(
  jobId: string,
  status: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  await db.issueJob.update({
    where: { id: jobId },
    data: { status: status as never, ...extra },
  });
}

export function createProcessor(config: Config, ai: AIRouter) {
  return async function processIssueResolve(job: Job<IssueResolvePayload>): Promise<void> {
    const { issueJobId } = job.data;
    const db = getDb();

    appLog.info(`Processing issue resolve job`, { issueJobId });

    // Load the issue job with its relations
    const issueJob = await db.issueJob.findUnique({
      where: { id: issueJobId },
      include: {
        ticket: {
          select: { subject: true, description: true, category: true, clientId: true },
        },
        repo: {
          select: {
            repoUrl: true,
            defaultBranch: true,
            branchPrefix: true,
          },
        },
      },
    });

    if (!issueJob) {
      logger.error({ issueJobId }, 'Issue job not found');
      return;
    }

    try {
      // Mark as started
      await updateJobStatus(issueJobId, 'CLONING', { startedAt: new Date() });

      // Step 1: Clone/prepare the repo
      const { git, localPath } = await prepareRepo({
        repoUrl: issueJob.repo.repoUrl,
        defaultBranch: issueJob.repo.defaultBranch,
        branchName: issueJob.branchName,
        workspacePath: config.REPO_WORKSPACE_PATH,
        authorName: config.GIT_AUTHOR_NAME,
        authorEmail: config.GIT_AUTHOR_EMAIL,
        cloneDepth: config.GIT_CLONE_DEPTH,
      });

      // Step 2: Analyze the issue with Claude
      await updateJobStatus(issueJobId, 'ANALYZING');

      const result = await resolveIssue({
        ai,
        repoPath: localPath,
        issueTitle: issueJob.ticket.subject,
        issueDescription: issueJob.ticket.description ?? '',
        issueCategory: issueJob.ticket.category,
        clientId: issueJob.ticket.clientId,
      });

      // Step 3: Apply the changes
      await updateJobStatus(issueJobId, 'APPLYING');
      await applyChanges(localPath, result.changes);

      // Step 4: Commit and push
      await updateJobStatus(issueJobId, 'PUSHING');

      const commitMessage = `fix: ${issueJob.ticket.subject}\n\n${result.summary}\n\nResolved by Bronco AI (${result.model})`;

      const { sha, filesChanged } = await commitAndPush(
        git,
        issueJob.branchName,
        commitMessage,
        issueJob.repo.defaultBranch,
      );

      // Step 5: Mark as completed
      await updateJobStatus(issueJobId, 'COMPLETED', {
        commitSha: sha,
        filesChanged,
        aiModel: result.model,
        aiUsage: result.usage,
        completedAt: new Date(),
      });

      // Create a ticket event documenting the code change
      await db.ticketEvent.create({
        data: {
          ticketId: issueJob.ticketId,
          eventType: 'CODE_CHANGE',
          content: `Automated code changes pushed to branch \`${issueJob.branchName}\`\n\n**Commit:** ${sha}\n**Files changed:** ${filesChanged}\n\n${result.summary}`,
          metadata: {
            issueJobId,
            branchName: issueJob.branchName,
            commitSha: sha,
            filesChanged,
            aiModel: result.model,
            aiUsage: result.usage,
          } as never,
          actor: 'issue-resolver',
        },
      });

      appLog.info(`Issue resolved: ${filesChanged} file(s) changed, pushed to ${issueJob.branchName}`, { issueJobId, sha, filesChanged, branchName: issueJob.branchName, ticketId: issueJob.ticketId }, issueJob.ticketId, 'ticket');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      appLog.error(`Issue resolution failed: ${errorMessage}`, { issueJobId, err: errorMessage, ticketId: issueJob.ticketId }, issueJob.ticketId, 'ticket');

      await updateJobStatus(issueJobId, 'FAILED', { error: errorMessage });

      // Log failure as a ticket event
      await db.ticketEvent.create({
        data: {
          ticketId: issueJob.ticketId,
          eventType: 'SYSTEM_NOTE',
          content: `Automated issue resolution failed: ${errorMessage}`,
          metadata: { issueJobId } as never,
          actor: 'issue-resolver',
        },
      });

      throw err;
    }
  };
}
