import type { PrismaClient } from '@bronco/db';
import type { ResolutionPlan } from '@bronco/shared-types';
import { Mailer, SlackClient, createLogger, decrypt, looksEncrypted, notifyOperators } from '@bronco/shared-utils';
import type { SlackMessageResult, SlackSender } from '@bronco/shared-utils';

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

const SETTINGS_KEY_SLACK = 'system-config-slack';

interface SlackConfig {
  botToken: string;
  appToken: string;
  defaultChannelId: string;
}

async function loadSlackConfig(db: PrismaClient, encryptionKey: string): Promise<SlackConfig | null> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SLACK } });
  if (!row) return null;

  const config = row.value as Record<string, unknown>;
  if (!config.enabled) return null;

  const decryptToken = (v: string) => looksEncrypted(v) ? decrypt(v, encryptionKey) : v;
  const botToken = typeof config.botToken === 'string' ? decryptToken(config.botToken) : '';
  const appToken = typeof config.appToken === 'string' ? decryptToken(config.appToken) : '';
  const channel = typeof config.defaultChannelId === 'string' ? config.defaultChannelId : '';

  if (!botToken || !appToken || !channel) return null;
  return { botToken, appToken, defaultChannelId: channel };
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

/** Build Block Kit blocks for a plan approval notification with interactive buttons. */
export function buildPlanApprovalBlocks(
  plan: ResolutionPlan,
  issueTitle: string,
  branchName: string,
  planRevision: number,
  issueJobId: string,
): unknown[] {
  const willDo = plan.actions.filter(a => a.category === 'WILL_DO');
  const revTag = planRevision > 1 ? ` (rev ${planRevision})` : '';

  const summaryLines = [
    `*Resolution Plan${revTag}: ${issueTitle}*`,
    `Branch: \`${branchName}\``,
    '',
    `*Summary:* ${plan.summary}`,
    `*Approach:* ${plan.approach}`,
  ];

  if (willDo.length > 0) {
    summaryLines.push('', '*Will Do (automated on approval):*');
    for (const a of willDo) {
      summaryLines.push(`• ${a.description}`);
    }
  }

  if (plan.openQuestions.length > 0) {
    summaryLines.push('', '*Open Questions:*');
    for (const q of plan.openQuestions) {
      summaryLines.push(`• ${q}`);
    }
  }

  summaryLines.push('', `_Estimated files to change: ${plan.estimatedFiles}_`);

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summaryLines.join('\n') },
    },
    {
      type: 'actions',
      block_id: `plan_${issueJobId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: 'plan_approve',
          value: issueJobId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          action_id: 'plan_reject',
          value: issueJobId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'More Detail' },
          action_id: 'plan_detail',
          value: issueJobId,
        },
      ],
    },
  ];
}

async function sendSlackPlanNotification(opts: {
  db: PrismaClient;
  encryptionKey: string;
  plan: ResolutionPlan;
  issueTitle: string;
  branchName: string;
  planRevision: number;
  issueJobId: string;
}): Promise<SlackMessageResult[]> {
  const { db, encryptionKey, plan, issueTitle, branchName, planRevision, issueJobId } = opts;
  const results: SlackMessageResult[] = [];

  const slackConfig = await loadSlackConfig(db, encryptionKey);
  if (!slackConfig) return results;

  const blocks = buildPlanApprovalBlocks(plan, issueTitle, branchName, planRevision, issueJobId);
  const revTag = planRevision > 1 ? ` (rev ${planRevision})` : '';
  const fallbackText = `Resolution Plan${revTag}: ${issueTitle} — Approve, Reject, or request More Detail`;

  // Create a temporary WebClient (no Socket Mode needed — just sending messages)
  const client = new SlackClient({ botToken: slackConfig.botToken, appToken: slackConfig.appToken });

  // Send to operators with notifySlack=true
  const operators = await db.operator.findMany({
    where: { isActive: true, notifySlack: true },
    select: { id: true, slackUserId: true },
  });

  for (const op of operators) {
    try {
      if (op.slackUserId) {
        const result = await client.sendDMWithTs(op.slackUserId, fallbackText, blocks);
        results.push(result);
        logger.info({ slackUserId: op.slackUserId, issueJobId }, 'Plan approval Slack DM sent');
      } else {
        const result = await client.sendMessageWithTs(slackConfig.defaultChannelId, fallbackText, blocks);
        results.push(result);
        logger.info({ channelId: slackConfig.defaultChannelId, issueJobId }, 'Plan approval Slack channel message sent');
      }
    } catch (err) {
      logger.warn({ err, operatorId: op.id, issueJobId }, 'Failed to send plan approval Slack notification');
    }
  }

  // If no operators with Slack enabled, send to the default channel
  if (operators.length === 0) {
    try {
      const result = await client.sendMessageWithTs(slackConfig.defaultChannelId, fallbackText, blocks);
      results.push(result);
      logger.info({ channelId: slackConfig.defaultChannelId, issueJobId }, 'Plan approval Slack channel message sent (no operators)');
    } catch (err) {
      logger.warn({ err, issueJobId }, 'Failed to send plan approval Slack notification to default channel');
    }
  }

  return results;
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

  // Send email notification
  try {
    const mailer = await createMailerFromChannel(db, encryptionKey);
    if (!mailer) {
      logger.debug({ issueJobId }, 'No active EMAIL notification channel — skipping plan email notification');
    } else {
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
          },
        );

        logger.info({ issueJobId }, 'Plan email notification dispatched via notifyOperators');
      } finally {
        await mailer.close();
      }
    }
  } catch (err) {
    // Non-blocking — log but don't fail the job
    logger.warn({ issueJobId, err }, 'Failed to send plan notification email');
  }

  // Send Slack notification with Block Kit buttons (non-blocking)
  try {
    const slackResults = await sendSlackPlanNotification(opts);

    // Store Slack message metadata in the issue job for thread tracking
    if (slackResults.length > 0) {
      const slackMeta = slackResults.map(r => ({ channelId: r.channelId, ts: r.ts }));
      const existing = await db.issueJob.findUnique({
        where: { id: issueJobId },
        select: { metadata: true },
      });
      const currentMeta = (existing?.metadata as Record<string, unknown>) ?? {};
      await db.issueJob.update({
        where: { id: issueJobId },
        data: {
          metadata: { ...currentMeta, slackNotifications: slackMeta },
        },
      });
    }
  } catch (err) {
    logger.warn({ issueJobId, err }, 'Failed to send plan Slack notification');
  }
}
