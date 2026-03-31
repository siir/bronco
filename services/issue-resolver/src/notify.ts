import type { PrismaClient } from '@bronco/db';
import type { ResolutionPlan } from '@bronco/shared-types';
import { Mailer, createLogger, decrypt, looksEncrypted, notifyOperators } from '@bronco/shared-utils';
import type { SlackSender } from '@bronco/shared-utils';

const logger = createLogger('issue-resolver:notify');

async function createMailerFromChannel(
  db: PrismaClient,
  encryptionKey: string,
): Promise<Mailer | null> {
  const channel = await db.notificationChannel.findFirst({
    where: { type: 'EMAIL', isActive: true },
  });

  if (!channel) return null;

  const cfg = channel.config as Record<string, unknown>;
  const password = typeof cfg.password === 'string' && looksEncrypted(cfg.password)
    ? decrypt(cfg.password, encryptionKey)
    : (cfg.password as string);

  return new Mailer({
    host: cfg.host as string,
    port: cfg.port as number,
    user: cfg.user as string,
    password,
    from: cfg.from as string,
  });
}

function formatPlanEmail(plan: ResolutionPlan, issueTitle: string, branchName: string, planRevision: number): { subject: string; body: string } {
  const willDo = plan.actions.filter(a => a.category === 'WILL_DO');
  const canDoIfAllowed = plan.actions.filter(a => a.category === 'CAN_DO_IF_ALLOWED');
  const cannotDo = plan.actions.filter(a => a.category === 'CANNOT_DO');

  const lines: string[] = [
    `Resolution plan generated for: ${issueTitle}`,
    `Branch: ${branchName}`,
    `Revision: ${planRevision}`,
    '',
    `Summary: ${plan.summary}`,
    '',
    `Approach: ${plan.approach}`,
    '',
  ];

  if (willDo.length > 0) {
    lines.push('=== Will Do (automated on approval) ===');
    for (const a of willDo) {
      lines.push(`  - ${a.description}`);
      if (a.files?.length) lines.push(`    Files: ${a.files.join(', ')}`);
    }
    lines.push('');
  }

  if (canDoIfAllowed.length > 0) {
    lines.push('=== Can Do If Allowed ===');
    for (const a of canDoIfAllowed) {
      lines.push(`  - ${a.description}`);
      if (a.requirement) lines.push(`    Requires: ${a.requirement}`);
    }
    lines.push('');
  }

  if (cannotDo.length > 0) {
    lines.push('=== Cannot Do (manual steps required) ===');
    for (const a of cannotDo) {
      lines.push(`  - ${a.description}`);
      if (a.manualSteps) lines.push(`    Manual: ${a.manualSteps}`);
    }
    lines.push('');
  }

  if (plan.assumptions.length > 0) {
    lines.push('Assumptions:');
    for (const a of plan.assumptions) lines.push(`  - ${a}`);
    lines.push('');
  }

  if (plan.openQuestions.length > 0) {
    lines.push('Open Questions:');
    for (const q of plan.openQuestions) lines.push(`  - ${q}`);
    lines.push('');
  }

  lines.push(`Estimated files to change: ${plan.estimatedFiles}`);
  lines.push('');
  lines.push('To approve or reject, use the control panel or API:');
  lines.push('  POST /api/issue-jobs/<id>/approve');
  lines.push('  POST /api/issue-jobs/<id>/reject  { "feedback": "..." }');
  lines.push('');
  lines.push('---');
  lines.push('This is an automated notification from Bronco issue resolver.');

  const revTag = planRevision > 1 ? ` (rev ${planRevision})` : '';
  return {
    subject: `[Bronco] Resolution plan${revTag}: ${issueTitle}`,
    body: lines.join('\n'),
  };
}

export async function notifyPlanGenerated(opts: {
  db: PrismaClient;
  encryptionKey: string;
  plan: ResolutionPlan;
  issueTitle: string;
  branchName: string;
  planRevision: number;
  issueJobId: string;
  slack?: SlackSender;
  defaultSlackChannelId?: string;
}): Promise<void> {
  const { db, encryptionKey, plan, issueTitle, branchName, planRevision, issueJobId } = opts;

  try {
    const mailer = await createMailerFromChannel(db, encryptionKey);
    if (!mailer) {
      logger.debug({ issueJobId }, 'No active EMAIL notification channel — skipping plan notification');
      return;
    }

    try {
      const { subject, body } = formatPlanEmail(plan, issueTitle, branchName, planRevision);

      await notifyOperators(
        mailer,
        () => db.operator.findMany({ where: { isActive: true } }),
        {
          subject,
          body,
          event: 'PLAN_READY',
          getPreference: (evt) => db.notificationPreference.findUnique({ where: { event: evt } }),
          slack: opts.slack,
          defaultSlackChannelId: opts.defaultSlackChannelId,
        },
      );

      logger.info({ issueJobId }, 'Plan notification dispatched via notifyOperators');
    } finally {
      await mailer.close();
    }
  } catch (err) {
    // Non-blocking — log but don't fail the job
    logger.warn({ issueJobId, err }, 'Failed to send plan notification');
  }
}
