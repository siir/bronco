import type { Job } from 'bullmq';
import { type PrismaClient, getDb } from '@bronco/db';
import type { AIRouter } from '@bronco/ai-provider';
import type { ResolutionPlan } from '@bronco/shared-types';
import { createLogger, AppLogger, createPrismaLogWriter } from '@bronco/shared-utils';
import type { Config } from './config.js';
import { prepareRepo, commitAndPush } from './git.js';
import { resolveIssue, applyChanges } from './resolver.js';
import { generatePlan, regeneratePlan } from './planner.js';
import { notifyPlanGenerated } from './notify.js';

const logger = createLogger('issue-resolver:worker');
const appLog = new AppLogger('issue-resolver');

export function initWorkerLogger(db: PrismaClient): void {
  appLog.setWriter(createPrismaLogWriter(db));
}

export interface IssueResolvePayload {
  issueJobId: string;
  /** When true, resumes an approved job from AWAITING_APPROVAL. */
  resume?: boolean;
  /** When set, regenerates the plan with the given feedback. */
  regenerateFeedback?: string;
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
    const { issueJobId, resume, regenerateFeedback } = job.data;
    const db = getDb();

    appLog.info(`Processing issue resolve job`, { issueJobId, resume: !!resume, regenerate: !!regenerateFeedback });

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
      // ── Handle plan regeneration (rejection with feedback) ──
      if (regenerateFeedback) {
        if (issueJob.status !== 'AWAITING_APPROVAL') {
          logger.warn({ issueJobId, status: issueJob.status }, 'Cannot regenerate plan — job not in AWAITING_APPROVAL');
          return;
        }

        await updateJobStatus(issueJobId, 'PLANNING');

        const { git, localPath } = await prepareRepo({
          repoUrl: issueJob.repo.repoUrl,
          defaultBranch: issueJob.repo.defaultBranch,
          branchName: issueJob.branchName,
          workspacePath: config.REPO_WORKSPACE_PATH,
          authorName: config.GIT_AUTHOR_NAME,
          authorEmail: config.GIT_AUTHOR_EMAIL,
          cloneDepth: config.GIT_CLONE_DEPTH,
        });

        const previousPlan = issueJob.plan as unknown as ResolutionPlan;
        const planResult = await regeneratePlan({
          ai,
          repoPath: localPath,
          issueTitle: issueJob.ticket.subject,
          issueDescription: issueJob.ticket.description ?? '',
          issueCategory: issueJob.ticket.category,
          clientId: issueJob.ticket.clientId,
          previousPlan,
          feedback: regenerateFeedback,
        });

        await updateJobStatus(issueJobId, 'AWAITING_APPROVAL', {
          plan: planResult.plan as unknown as Record<string, unknown>,
          planRevision: issueJob.planRevision + 1,
          planFeedback: regenerateFeedback,
          aiModel: planResult.model,
          aiUsage: planResult.usage,
        });

        appLog.info(
          `Plan regenerated (revision ${issueJob.planRevision + 1}), awaiting approval`,
          { issueJobId, planRevision: issueJob.planRevision + 1, ticketId: issueJob.ticketId },
          issueJob.ticketId,
          'ticket',
        );

        // Non-blocking notification
        notifyPlanGenerated({
          db,
          encryptionKey: config.ENCRYPTION_KEY,
          plan: planResult.plan,
          issueTitle: issueJob.ticket.subject,
          branchName: issueJob.branchName,
          planRevision: issueJob.planRevision + 1,
          issueJobId,
        }).catch(() => {});

        return;
      }

      // ── Handle approval resume ──
      if (resume) {
        if (issueJob.status !== 'AWAITING_APPROVAL') {
          logger.warn({ issueJobId, status: issueJob.status }, 'Cannot resume — job not in AWAITING_APPROVAL');
          return;
        }

        const plan = issueJob.plan as unknown as ResolutionPlan;
        if (!plan) {
          throw new Error('Cannot resume: no plan found on job');
        }

        // Clone/prepare the repo
        await updateJobStatus(issueJobId, 'CLONING');
        const { git, localPath } = await prepareRepo({
          repoUrl: issueJob.repo.repoUrl,
          defaultBranch: issueJob.repo.defaultBranch,
          branchName: issueJob.branchName,
          workspacePath: config.REPO_WORKSPACE_PATH,
          authorName: config.GIT_AUTHOR_NAME,
          authorEmail: config.GIT_AUTHOR_EMAIL,
          cloneDepth: config.GIT_CLONE_DEPTH,
        });

        // Generate code changes guided by the approved plan
        await updateJobStatus(issueJobId, 'APPLYING');
        const result = await resolveIssue({
          ai,
          repoPath: localPath,
          issueTitle: issueJob.ticket.subject,
          issueDescription: issueJob.ticket.description ?? '',
          issueCategory: issueJob.ticket.category,
          clientId: issueJob.ticket.clientId,
          plan,
        });

        await applyChanges(localPath, result.changes);

        // Commit and push
        await updateJobStatus(issueJobId, 'PUSHING');

        const commitMessage = `fix: ${issueJob.ticket.subject}\n\n${result.summary}\n\nResolved by Bronco AI (${result.model})`;

        const { sha, filesChanged } = await commitAndPush(
          git,
          issueJob.branchName,
          commitMessage,
          issueJob.repo.defaultBranch,
        );

        await updateJobStatus(issueJobId, 'COMPLETED', {
          commitSha: sha,
          filesChanged,
          aiModel: result.model,
          aiUsage: result.usage,
          completedAt: new Date(),
        });

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
        return;
      }

      // ── Normal flow: new job ──

      // Step 1: Clone/prepare the repo
      await updateJobStatus(issueJobId, 'CLONING', { startedAt: new Date() });

      const { git, localPath } = await prepareRepo({
        repoUrl: issueJob.repo.repoUrl,
        defaultBranch: issueJob.repo.defaultBranch,
        branchName: issueJob.branchName,
        workspacePath: config.REPO_WORKSPACE_PATH,
        authorName: config.GIT_AUTHOR_NAME,
        authorEmail: config.GIT_AUTHOR_EMAIL,
        cloneDepth: config.GIT_CLONE_DEPTH,
      });

      // Step 2: Analyze the issue (part of plan generation context)
      await updateJobStatus(issueJobId, 'ANALYZING');

      // Step 3: Generate plan
      await updateJobStatus(issueJobId, 'PLANNING');

      const planResult = await generatePlan({
        ai,
        repoPath: localPath,
        issueTitle: issueJob.ticket.subject,
        issueDescription: issueJob.ticket.description ?? '',
        issueCategory: issueJob.ticket.category,
        clientId: issueJob.ticket.clientId,
      });

      // Step 4: Store plan, transition to AWAITING_APPROVAL — worker stops here
      await updateJobStatus(issueJobId, 'AWAITING_APPROVAL', {
        plan: planResult.plan as unknown as Record<string, unknown>,
        planRevision: 1,
        aiModel: planResult.model,
        aiUsage: planResult.usage,
      });

      // Create a ticket event documenting the plan
      await db.ticketEvent.create({
        data: {
          ticketId: issueJob.ticketId,
          eventType: 'SYSTEM_NOTE',
          content: `Resolution plan generated for branch \`${issueJob.branchName}\`\n\n**Summary:** ${planResult.plan.summary}\n**Approach:** ${planResult.plan.approach}\n**Estimated files:** ${planResult.plan.estimatedFiles}\n\nAwaiting operator approval.`,
          metadata: {
            issueJobId,
            planRevision: 1,
            aiModel: planResult.model,
          } as never,
          actor: 'issue-resolver',
        },
      });

      appLog.info(
        `Plan generated, awaiting operator approval`,
        { issueJobId, estimatedFiles: planResult.plan.estimatedFiles, ticketId: issueJob.ticketId },
        issueJob.ticketId,
        'ticket',
      );

      // Non-blocking notification
      notifyPlanGenerated({
        db,
        encryptionKey: config.ENCRYPTION_KEY,
        plan: planResult.plan,
        issueTitle: issueJob.ticket.subject,
        branchName: issueJob.branchName,
        planRevision: 1,
        issueJobId,
      }).catch(() => {});

      // Worker completes here — execution resumes on approval via a new queue job
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
