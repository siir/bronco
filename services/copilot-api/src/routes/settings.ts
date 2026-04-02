import type { FastifyInstance } from 'fastify';
import { TicketStatus, TicketCategory, DEFAULT_OPERATIONAL_ALERT_CONFIG, DEFAULT_ACTION_SAFETY_CONFIG } from '@bronco/shared-types';
import type { OperationalAlertConfig, ActionSafetyConfig, ActionSafetyLevel } from '@bronco/shared-types';
import { Mailer, createLogger, decrypt, encrypt, loadSmtpFromDb, looksEncrypted } from '@bronco/shared-utils';
import { z } from 'zod';

const settingsLogger = createLogger('settings');

/** Default configs seeded lazily if the DB tables are empty. */
const DEFAULT_STATUS_CONFIGS = [
  { value: TicketStatus.OPEN, displayName: 'Open', description: 'Newly created ticket awaiting triage', color: '#2196f3', sortOrder: 0, statusClass: 'open' },
  { value: TicketStatus.IN_PROGRESS, displayName: 'In Progress', description: 'Actively being worked on', color: '#ff9800', sortOrder: 1, statusClass: 'open' },
  { value: TicketStatus.WAITING, displayName: 'Waiting', description: 'Waiting for external input or response', color: '#9c27b0', sortOrder: 2, statusClass: 'open' },
  { value: TicketStatus.RESOLVED, displayName: 'Resolved', description: 'Issue has been resolved', color: '#4caf50', sortOrder: 3, statusClass: 'closed' },
  { value: TicketStatus.CLOSED, displayName: 'Closed', description: 'Ticket is closed', color: '#757575', sortOrder: 4, statusClass: 'closed' },
];

const DEFAULT_CATEGORY_CONFIGS = [
  { value: TicketCategory.DATABASE_PERF, displayName: 'Database Performance', description: 'Query performance, blocking, index tuning, health issues', color: '#f44336', sortOrder: 0 },
  { value: TicketCategory.BUG_FIX, displayName: 'Bug Fix', description: 'Bugs across database, API, and client applications', color: '#e91e63', sortOrder: 1 },
  { value: TicketCategory.FEATURE_REQUEST, displayName: 'Feature Request', description: 'New features for API endpoints or client apps', color: '#2196f3', sortOrder: 2 },
  { value: TicketCategory.SCHEMA_CHANGE, displayName: 'Schema Change', description: 'Database schema modifications (new tables, columns, migrations)', color: '#ff9800', sortOrder: 3 },
  { value: TicketCategory.CODE_REVIEW, displayName: 'Code Review', description: 'Code review and quality tasks', color: '#9c27b0', sortOrder: 4 },
  { value: TicketCategory.ARCHITECTURE, displayName: 'Architecture', description: 'System design and architecture decisions', color: '#009688', sortOrder: 5 },
  { value: TicketCategory.GENERAL, displayName: 'General', description: 'Anything that does not fit the above categories', color: '#757575', sortOrder: 6 },
];

const VALID_STATUSES: ReadonlySet<string> = new Set(Object.values(TicketStatus));
const VALID_CATEGORIES: ReadonlySet<string> = new Set(Object.values(TicketCategory));
const VALID_STATUS_CLASSES: ReadonlySet<string> = new Set(['open', 'closed']);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const logger = createLogger('settings');

const SETTINGS_KEY_OPERATIONAL_ALERTS = 'operational-alerts';
const SETTINGS_KEY_SUPER_ADMIN = 'super-admin-user-id';
const SETTINGS_KEY_SMTP = 'system-config-smtp';
const SETTINGS_KEY_DEVOPS = 'system-config-devops';
const SETTINGS_KEY_GITHUB = 'system-config-github';
const SETTINGS_KEY_IMAP = 'system-config-imap';
const SETTINGS_KEY_SLACK = 'system-config-slack';
const SETTINGS_KEY_PROMPT_RETENTION = 'system-config-prompt-retention';
const SETTINGS_KEY_ACTION_SAFETY = 'system-config-action-safety';
const SETTINGS_KEY_ANALYSIS_STRATEGY = 'system-config-analysis-strategy';

const REDACTED = '••••••••';

const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  user: z.string().min(1),
  password: z.string().min(1),
  from: z.string().min(1),
  fromName: z.string().optional(),
});

const devopsConfigSchema = z.object({
  orgUrl: z.string().url(),
  project: z.string().min(1),
  pat: z.string().min(1),
  assignedUser: z.string().min(1),
  clientShortCode: z.string().optional(),
  pollIntervalSeconds: z.coerce.number().int().min(30).optional(),
});

const githubConfigSchema = z.object({
  token: z.string().min(1),
  repo: z.string().min(1),
});

const imapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  user: z.string().min(1),
  password: z.string().min(1),
  pollIntervalSeconds: z.coerce.number().int().min(10).optional().default(60),
});

const slackConfigSchema = z
  .object({
    botToken: z.string().default(''),
    appToken: z.string().default(''),
    defaultChannelId: z.string().default(''),
    enabled: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    if (!value.botToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'botToken is required when Slack is enabled', path: ['botToken'] });
    }
    if (!value.appToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'appToken is required when Slack is enabled', path: ['appToken'] });
    }
    if (!value.defaultChannelId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'defaultChannelId is required when Slack is enabled', path: ['defaultChannelId'] });
    }
  });

const operationalAlertConfigSchema = z
  .object({
    enabled: z.boolean(),
    recipientEmail: z.string().transform((value) => value.trim()),
    throttleMinutes: z.number().int().min(1),
    alerts: z.object({
      failedJobs: z.boolean(),
      probeMisses: z.boolean(),
      aiProviderDown: z.boolean(),
      devopsSyncStale: z.boolean(),
      summarizationStale: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    const email = value.recipientEmail;

    if (!value.enabled) {
      // When alerts are disabled, allow an empty or missing recipientEmail.
      return;
    }

    if (!email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recipientEmail is required when alerts are enabled',
        path: ['recipientEmail'],
      });
      return;
    }

    if (!EMAIL_RE.test(email)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recipientEmail must be a valid email address',
        path: ['recipientEmail'],
      });
    }
  });

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

interface SettingsRouteOpts {
  encryptionKey: string;
  issueResolveQueue?: import('bullmq').Queue;
}

export async function settingsRoutes(fastify: FastifyInstance, opts: SettingsRouteOpts): Promise<void> {
  // ─── Ticket Statuses ───

  // GET /api/settings/statuses — list all status configs (auto-seed if empty)
  fastify.get('/api/settings/statuses', async () => {
    let configs = await fastify.db.ticketStatusConfig.findMany({ orderBy: { sortOrder: 'asc' } });

    if (configs.length === 0) {
      await fastify.db.ticketStatusConfig.createMany({ data: DEFAULT_STATUS_CONFIGS, skipDuplicates: true });
      configs = await fastify.db.ticketStatusConfig.findMany({ orderBy: { sortOrder: 'asc' } });
    }

    return configs;
  });

  // PATCH /api/settings/statuses/:value — update a status config
  fastify.patch<{
    Params: { value: string };
    Body: {
      displayName?: string;
      description?: string | null;
      color?: string;
      sortOrder?: number;
      statusClass?: string;
      isActive?: boolean;
    };
  }>('/api/settings/statuses/:value', async (request) => {
    const { value } = request.params;
    if (!VALID_STATUSES.has(value)) {
      return fastify.httpErrors.badRequest(`Invalid status value: ${value}`);
    }

    const body = request.body ?? {};

    if (body.displayName !== undefined && (typeof body.displayName !== 'string' || body.displayName.trim().length === 0)) {
      return fastify.httpErrors.badRequest('displayName must be a non-empty string');
    }
    if (body.color !== undefined && !COLOR_RE.test(body.color)) {
      return fastify.httpErrors.badRequest('color must be a valid hex color (e.g. #ff9800)');
    }
    if (body.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || body.sortOrder < 0)) {
      return fastify.httpErrors.badRequest('sortOrder must be a non-negative integer');
    }
    if (body.statusClass !== undefined && !VALID_STATUS_CLASSES.has(body.statusClass)) {
      return fastify.httpErrors.badRequest('statusClass must be "open" or "closed"');
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return fastify.httpErrors.badRequest('description must be a string or null');
    }
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return fastify.httpErrors.badRequest('isActive must be a boolean');
    }

    try {
      return await fastify.db.ticketStatusConfig.update({
        where: { value },
        data: {
          ...(body.displayName !== undefined && { displayName: body.displayName.trim() }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.color !== undefined && { color: body.color }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
          ...(body.statusClass !== undefined && { statusClass: body.statusClass }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound(`Status config not found: ${value}`);
      }
      throw err;
    }
  });

  // POST /api/settings/statuses — create a new status config
  fastify.post<{
    Body: {
      value: string;
      displayName: string;
      color: string;
      statusClass: string;
      sortOrder?: number;
      description?: string | null;
    };
  }>('/api/settings/statuses', async (request, reply) => {
    const body = request.body ?? {} as Record<string, unknown>;
    const { value, displayName, color, statusClass, sortOrder, description } = body;

    if (!value || !VALID_STATUSES.has(value)) {
      return fastify.httpErrors.badRequest(`Invalid status value: ${value}`);
    }
    if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
      return fastify.httpErrors.badRequest('displayName must be a non-empty string');
    }
    if (typeof color !== 'string' || !COLOR_RE.test(color)) {
      return fastify.httpErrors.badRequest('color must be a valid hex color (e.g. #ff9800)');
    }
    if (!statusClass || !VALID_STATUS_CLASSES.has(statusClass)) {
      return fastify.httpErrors.badRequest('statusClass must be "open" or "closed"');
    }
    if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0)) {
      return fastify.httpErrors.badRequest('sortOrder must be a non-negative integer');
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return fastify.httpErrors.badRequest('description must be a string or null');
    }

    try {
      const created = await fastify.db.ticketStatusConfig.create({
        data: {
          value,
          displayName: displayName.trim(),
          color,
          statusClass,
          sortOrder: sortOrder ?? 0,
          description: description ?? null,
          isActive: true,
        },
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(`Status config already exists: ${value}`);
      }
      throw err;
    }
  });

  // ─── Ticket Categories ───

  // GET /api/settings/categories — list all category configs (auto-seed if empty)
  fastify.get('/api/settings/categories', async () => {
    let configs = await fastify.db.ticketCategoryConfig.findMany({ orderBy: { sortOrder: 'asc' } });

    if (configs.length === 0) {
      await fastify.db.ticketCategoryConfig.createMany({ data: DEFAULT_CATEGORY_CONFIGS, skipDuplicates: true });
      configs = await fastify.db.ticketCategoryConfig.findMany({ orderBy: { sortOrder: 'asc' } });
    }

    return configs;
  });

  // POST /api/settings/categories — create a new category config
  fastify.post<{
    Body: {
      value: string;
      displayName: string;
      color: string;
      sortOrder?: number;
      description?: string | null;
    };
  }>('/api/settings/categories', async (request, reply) => {
    const body = request.body ?? {} as Record<string, unknown>;
    const { value, displayName, color, sortOrder, description } = body;

    if (!value || !VALID_CATEGORIES.has(value)) {
      return fastify.httpErrors.badRequest(`Invalid category value: ${value}`);
    }
    if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
      return fastify.httpErrors.badRequest('displayName must be a non-empty string');
    }
    if (typeof color !== 'string' || !COLOR_RE.test(color)) {
      return fastify.httpErrors.badRequest('color must be a valid hex color (e.g. #ff9800)');
    }
    if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0)) {
      return fastify.httpErrors.badRequest('sortOrder must be a non-negative integer');
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return fastify.httpErrors.badRequest('description must be a string or null');
    }

    try {
      const created = await fastify.db.ticketCategoryConfig.create({
        data: {
          value,
          displayName: displayName.trim(),
          color,
          sortOrder: sortOrder ?? 0,
          description: description ?? null,
          isActive: true,
        },
      });
      return reply.code(201).send(created);
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(`Category config already exists: ${value}`);
      }
      throw err;
    }
  });

  // PATCH /api/settings/categories/:value — update a category config
  fastify.patch<{
    Params: { value: string };
    Body: {
      displayName?: string;
      description?: string | null;
      color?: string;
      sortOrder?: number;
      isActive?: boolean;
    };
  }>('/api/settings/categories/:value', async (request) => {
    const { value } = request.params;
    if (!VALID_CATEGORIES.has(value)) {
      return fastify.httpErrors.badRequest(`Invalid category value: ${value}`);
    }

    const body = request.body ?? {};

    if (body.displayName !== undefined && (typeof body.displayName !== 'string' || body.displayName.trim().length === 0)) {
      return fastify.httpErrors.badRequest('displayName must be a non-empty string');
    }
    if (body.color !== undefined && !COLOR_RE.test(body.color)) {
      return fastify.httpErrors.badRequest('color must be a valid hex color (e.g. #ff9800)');
    }
    if (body.sortOrder !== undefined && (!Number.isInteger(body.sortOrder) || body.sortOrder < 0)) {
      return fastify.httpErrors.badRequest('sortOrder must be a non-negative integer');
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return fastify.httpErrors.badRequest('description must be a string or null');
    }
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return fastify.httpErrors.badRequest('isActive must be a boolean');
    }

    try {
      return await fastify.db.ticketCategoryConfig.update({
        where: { value },
        data: {
          ...(body.displayName !== undefined && { displayName: body.displayName.trim() }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.color !== undefined && { color: body.color }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound(`Category config not found: ${value}`);
      }
      throw err;
    }
  });

  // ─── Operational Alerts ───

  // GET /api/settings/operational-alerts — get alert config (returns defaults if not set)
  fastify.get('/api/settings/operational-alerts', async () => {
    const row = await fastify.db.appSetting.findUnique({
      where: { key: SETTINGS_KEY_OPERATIONAL_ALERTS },
    });
    if (!row) return DEFAULT_OPERATIONAL_ALERT_CONFIG;
    return row.value as unknown as OperationalAlertConfig;
  });

  // PUT /api/settings/operational-alerts — save alert config
  fastify.put<{ Body: OperationalAlertConfig }>(
    '/api/settings/operational-alerts',
    async (request) => {
      const parsed = operationalAlertConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return fastify.httpErrors.badRequest(`Invalid alert config: ${issues}`);
      }

      const config = parsed.data;

      const row = await fastify.db.appSetting.upsert({
        where: { key: SETTINGS_KEY_OPERATIONAL_ALERTS },
        update: { value: config as unknown as object },
        create: { key: SETTINGS_KEY_OPERATIONAL_ALERTS, value: config as unknown as object },
      });

      return row.value as unknown as OperationalAlertConfig;
    },
  );

  // POST /api/settings/operational-alerts/test — send a test alert email
  fastify.post('/api/settings/operational-alerts/test', async (request) => {
    // Load alert config
    const settingRow = await fastify.db.appSetting.findUnique({
      where: { key: SETTINGS_KEY_OPERATIONAL_ALERTS },
    });
    const alertConfig = settingRow
      ? (settingRow.value as unknown as OperationalAlertConfig)
      : DEFAULT_OPERATIONAL_ALERT_CONFIG;

    if (!alertConfig.recipientEmail) {
      return fastify.httpErrors.badRequest('No recipient email configured in operational alert settings');
    }

    // Load SMTP config from System Settings
    const smtpConfig = await loadSmtpFromDb(fastify.db, opts.encryptionKey);
    if (!smtpConfig) {
      return fastify.httpErrors.badRequest(
        'SMTP not configured. Configure it in System Settings → SMTP.',
      );
    }

    const mailer = new Mailer(smtpConfig);

    try {
      await mailer.send({
        to: alertConfig.recipientEmail,
        subject: '[Bronco Alert] Test notification',
        body: [
          'This is a test alert from Bronco operational monitoring.',
          '',
          'If you received this email, your alert configuration is working correctly.',
          '',
          '---',
          'To configure alerts: Control Panel → Settings → Operational Alerts.',
        ].join('\n'),
      });
      return { success: true, message: `Test alert sent to ${alertConfig.recipientEmail}` };
    } catch (err) {
      logger.error({ err }, 'Test alert email failed');
      return { success: false, error: err instanceof Error ? err.message : 'Failed to send test email' };
    } finally {
      await mailer.close();
    }
  });

  // ─── System Config: SMTP ───

  // GET /api/settings/smtp — get SMTP config (redacted)
  fastify.get('/api/settings/smtp', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SMTP } });
    if (!row) return null;
    const config = row.value as Record<string, unknown>;
    return { ...config, password: REDACTED };
  });

  // PUT /api/settings/smtp — save SMTP config
  fastify.put<{ Body: Record<string, unknown> }>('/api/settings/smtp', async (request) => {
    const parsed = smtpConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fastify.httpErrors.badRequest(`Invalid SMTP config: ${issues}`);
    }

    const incoming = parsed.data as Record<string, unknown>;

    const existing = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SMTP } });
    if (incoming.password === REDACTED && existing) {
      const prev = existing.value as Record<string, unknown>;
      incoming.password = prev.password;
    } else if (incoming.password === REDACTED) {
      return fastify.httpErrors.badRequest('SMTP password is required when creating a new configuration');
    } else if (typeof incoming.password === 'string' && !looksEncrypted(incoming.password)) {
      incoming.password = encrypt(incoming.password, opts.encryptionKey);
    }

    const row = await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_SMTP },
      update: { value: incoming as object },
      create: { key: SETTINGS_KEY_SMTP, value: incoming as object },
    });

    const saved = row.value as Record<string, unknown>;
    return { ...saved, password: REDACTED };
  });

  // POST /api/settings/smtp/test — verify SMTP connectivity
  fastify.post('/api/settings/smtp/test', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SMTP } });
    if (!row) return fastify.httpErrors.badRequest('SMTP not configured');

    const config = row.value as Record<string, unknown>;
    const password = typeof config.password === 'string' && looksEncrypted(config.password)
      ? decrypt(config.password, opts.encryptionKey)
      : config.password as string;

    const mailer = new Mailer({
      host: config.host as string,
      port: config.port as number,
      user: config.user as string,
      password,
      from: config.from as string,
      fromName: config.fromName as string | undefined,
    });

    try {
      const ok = await mailer.verify();
      if (ok) return { success: true, message: 'SMTP connection verified' };
      return { success: false, error: 'SMTP verification failed' };
    } catch (err) {
      logger.error({ err }, 'SMTP test failed');
      return { success: false, error: err instanceof Error ? err.message : 'SMTP test failed' };
    } finally {
      await mailer.close();
    }
  });

  // ─── System Config: Azure DevOps ───

  // GET /api/settings/devops — get DevOps config (redacted)
  fastify.get('/api/settings/devops', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_DEVOPS } });
    if (!row) return null;
    const config = row.value as Record<string, unknown>;
    return { ...config, pat: REDACTED };
  });

  // PUT /api/settings/devops — save DevOps config
  fastify.put<{ Body: Record<string, unknown> }>('/api/settings/devops', async (request) => {
    const parsed = devopsConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fastify.httpErrors.badRequest(`Invalid DevOps config: ${issues}`);
    }

    const incoming = parsed.data as Record<string, unknown>;

    const existing = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_DEVOPS } });
    if (incoming.pat === REDACTED && existing) {
      const prev = existing.value as Record<string, unknown>;
      incoming.pat = prev.pat;
    } else if (incoming.pat === REDACTED) {
      return fastify.httpErrors.badRequest('DevOps PAT is required when creating a new configuration');
    } else if (typeof incoming.pat === 'string' && !looksEncrypted(incoming.pat)) {
      incoming.pat = encrypt(incoming.pat, opts.encryptionKey);
    }

    const row = await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_DEVOPS },
      update: { value: incoming as object },
      create: { key: SETTINGS_KEY_DEVOPS, value: incoming as object },
    });

    const saved = row.value as Record<string, unknown>;
    return { ...saved, pat: REDACTED };
  });

  // POST /api/settings/devops/test — verify DevOps PAT + org/project access
  fastify.post('/api/settings/devops/test', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_DEVOPS } });
    if (!row) return fastify.httpErrors.badRequest('Azure DevOps not configured');

    const config = row.value as Record<string, unknown>;
    const pat = typeof config.pat === 'string' && looksEncrypted(config.pat)
      ? decrypt(config.pat, opts.encryptionKey)
      : config.pat as string;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `${config.orgUrl}/_apis/projects/${encodeURIComponent(config.project as string)}?api-version=7.1`,
        { signal: controller.signal, headers: { Authorization: `Basic ${Buffer.from(':' + pat).toString('base64')}` } },
      );
      return { success: res.ok, message: res.ok ? 'Connected to Azure DevOps' : `HTTP ${res.status}` };
    } catch (err) {
      logger.error({ err }, 'DevOps test failed');
      return { success: false, error: err instanceof Error ? err.message : 'DevOps test failed' };
    } finally {
      clearTimeout(timeout);
    }
  });

  // ─── System Config: GitHub ───

  // GET /api/settings/github — get GitHub config (redacted)
  fastify.get('/api/settings/github', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_GITHUB } });
    if (!row) return null;
    const config = row.value as Record<string, unknown>;
    return { ...config, token: REDACTED };
  });

  // PUT /api/settings/github — save GitHub config
  fastify.put<{ Body: Record<string, unknown> }>('/api/settings/github', async (request) => {
    const parsed = githubConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fastify.httpErrors.badRequest(`Invalid GitHub config: ${issues}`);
    }

    const incoming = parsed.data as Record<string, unknown>;

    const existing = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_GITHUB } });
    if (incoming.token === REDACTED && existing) {
      const prev = existing.value as Record<string, unknown>;
      incoming.token = prev.token;
    } else if (incoming.token === REDACTED) {
      return fastify.httpErrors.badRequest('GitHub token is required when creating a new configuration');
    } else if (typeof incoming.token === 'string' && !looksEncrypted(incoming.token)) {
      incoming.token = encrypt(incoming.token, opts.encryptionKey);
    }

    const row = await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_GITHUB },
      update: { value: incoming as object },
      create: { key: SETTINGS_KEY_GITHUB, value: incoming as object },
    });

    const saved = row.value as Record<string, unknown>;
    return { ...saved, token: REDACTED };
  });

  // POST /api/settings/github/test — verify GitHub token
  fastify.post('/api/settings/github/test', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_GITHUB } });
    if (!row) return fastify.httpErrors.badRequest('GitHub not configured');

    const config = row.value as Record<string, unknown>;
    const token = typeof config.token === 'string' && looksEncrypted(config.token)
      ? decrypt(config.token, opts.encryptionKey)
      : config.token as string;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch('https://api.github.com/user', {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'bronco' },
      });
      return { success: res.ok, message: res.ok ? 'GitHub token valid' : `HTTP ${res.status}` };
    } catch (err) {
      logger.error({ err }, 'GitHub test failed');
      return { success: false, error: err instanceof Error ? err.message : 'GitHub test failed' };
    } finally {
      clearTimeout(timeout);
    }
  });

  // ─── System Config: IMAP ───

  // GET /api/settings/imap — get IMAP config (redacted)
  fastify.get('/api/settings/imap', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_IMAP } });
    if (!row) return null;
    const config = row.value as Record<string, unknown>;
    return { ...config, password: REDACTED };
  });

  // PUT /api/settings/imap — save IMAP config
  fastify.put<{ Body: Record<string, unknown> }>('/api/settings/imap', async (request) => {
    const parsed = imapConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fastify.httpErrors.badRequest(`Invalid IMAP config: ${issues}`);
    }

    const incoming = parsed.data as Record<string, unknown>;

    const existing = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_IMAP } });
    if (incoming.password === REDACTED && existing) {
      const prev = existing.value as Record<string, unknown>;
      incoming.password = prev.password;
    } else if (incoming.password === REDACTED) {
      return fastify.httpErrors.badRequest('IMAP password is required when creating a new configuration');
    } else if (typeof incoming.password === 'string' && !looksEncrypted(incoming.password)) {
      incoming.password = encrypt(incoming.password, opts.encryptionKey);
    }

    const row = await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_IMAP },
      update: { value: incoming as object },
      create: { key: SETTINGS_KEY_IMAP, value: incoming as object },
    });

    const saved = row.value as Record<string, unknown>;
    return { ...saved, password: REDACTED };
  });

  // POST /api/settings/imap/test — verify IMAP connectivity
  fastify.post('/api/settings/imap/test', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_IMAP } });
    if (!row) return fastify.httpErrors.badRequest('IMAP not configured');

    const config = row.value as Record<string, unknown>;
    const password = typeof config.password === 'string' && looksEncrypted(config.password)
      ? decrypt(config.password, opts.encryptionKey)
      : config.password as string;

    const { ImapFlow } = await import('imapflow');
    const port = Number(config.port) || 993;
    const client = new ImapFlow({
      host: config.host as string,
      port,
      secure: port === 993,
      auth: { user: config.user as string, pass: password },
      logger: false,
    });

    let connected = false;
    try {
      await client.connect();
      connected = true;
      const mailboxes = await client.list();
      await client.logout();
      connected = false;
      return { success: true, message: `IMAP connected — ${mailboxes.length} folder(s) found` };
    } catch (err) {
      if (connected) {
        client.logout().catch(() => {});
      }
      logger.error({ err }, 'IMAP test failed');
      return { success: false, error: err instanceof Error ? err.message : 'IMAP test failed' };
    }
  });

  // ─── System Config: Slack ───

  // GET /api/settings/slack — get Slack config (redacted)
  fastify.get('/api/settings/slack', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SLACK } });
    if (!row) return null;
    const config = row.value as Record<string, unknown>;
    return { ...config, botToken: REDACTED, appToken: REDACTED };
  });

  // PUT /api/settings/slack — save Slack config
  fastify.put<{ Body: Record<string, unknown> }>('/api/settings/slack', async (request) => {
    const parsed = slackConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fastify.httpErrors.badRequest(`Invalid Slack config: ${issues}`);
    }

    const incoming = parsed.data as Record<string, unknown>;

    const existing = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SLACK } });

    // Handle botToken redaction
    if (incoming.botToken === REDACTED && existing) {
      const prev = existing.value as Record<string, unknown>;
      incoming.botToken = prev.botToken;
    } else if (incoming.botToken === REDACTED) {
      return fastify.httpErrors.badRequest('Bot token is required when creating a new configuration');
    } else if (typeof incoming.botToken === 'string' && !looksEncrypted(incoming.botToken)) {
      incoming.botToken = encrypt(incoming.botToken, opts.encryptionKey);
    }

    // Handle appToken redaction
    if (incoming.appToken === REDACTED && existing) {
      const prev = existing.value as Record<string, unknown>;
      incoming.appToken = prev.appToken;
    } else if (incoming.appToken === REDACTED) {
      return fastify.httpErrors.badRequest('App token is required when creating a new configuration');
    } else if (typeof incoming.appToken === 'string' && !looksEncrypted(incoming.appToken)) {
      incoming.appToken = encrypt(incoming.appToken, opts.encryptionKey);
    }

    const row = await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_SLACK },
      update: { value: incoming as object },
      create: { key: SETTINGS_KEY_SLACK, value: incoming as object },
    });

    const saved = row.value as Record<string, unknown>;

    // Slack connection is managed by slack-worker — config changes require a slack-worker restart to take effect
    // TODO: Add cross-service notification (e.g., BullMQ job) so slack-worker can refresh without restart
    settingsLogger.info('Slack config updated — slack-worker restart required to pick up changes');

    return { ...saved, botToken: REDACTED, appToken: REDACTED };
  });

  // POST /api/settings/slack/test — test Slack connectivity
  fastify.post('/api/settings/slack/test', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SLACK } });
    if (!row) return fastify.httpErrors.badRequest('Slack not configured');

    const config = row.value as Record<string, unknown>;

    if (typeof config.botToken !== 'string' || !config.botToken) {
      return fastify.httpErrors.badRequest('Bot token is missing from Slack configuration');
    }
    if (typeof config.appToken !== 'string' || !config.appToken) {
      return fastify.httpErrors.badRequest('App token is missing from Slack configuration');
    }

    let botToken: string;
    let appToken: string;
    try {
      botToken = looksEncrypted(config.botToken) ? decrypt(config.botToken, opts.encryptionKey) : config.botToken;
      appToken = looksEncrypted(config.appToken) ? decrypt(config.appToken, opts.encryptionKey) : config.appToken;
    } catch (err) {
      logger.warn({ err }, 'Failed to decrypt Slack tokens for test');
      return fastify.httpErrors.badRequest('Failed to decrypt Slack tokens — reconfigure and try again');
    }

    const { SlackClient } = await import('@bronco/shared-utils');
    const client = new SlackClient({ botToken, appToken });

    try {
      const result = await client.testConnection();
      return {
        success: true,
        message: `Connected as ${result.botName ?? 'unknown'} — ${result.channelCount ?? 0} channel(s) visible`,
      };
    } catch (err) {
      logger.error({ err }, 'Slack test failed');
      return { success: false, error: err instanceof Error ? err.message : 'Slack test failed' };
    }
  });

  // ─── Prompt Retention ───

  const promptRetentionSchema = z.object({
    fullRetentionDays: z.number().int().min(1).default(30),
    summaryRetentionDays: z.number().int().min(1).default(90),
  });

  const DEFAULT_PROMPT_RETENTION = { fullRetentionDays: 30, summaryRetentionDays: 90 };

  // GET /api/settings/prompt-retention — get prompt retention config
  fastify.get('/api/settings/prompt-retention', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_PROMPT_RETENTION } });
    if (!row) return DEFAULT_PROMPT_RETENTION;
    const parsed = promptRetentionSchema.safeParse(row.value);
    return parsed.success ? parsed.data : DEFAULT_PROMPT_RETENTION;
  });

  // PUT /api/settings/prompt-retention — save prompt retention config
  fastify.put<{ Body: { fullRetentionDays?: number; summaryRetentionDays?: number } }>(
    '/api/settings/prompt-retention',
    async (request) => {
      const parsed = promptRetentionSchema.safeParse(request.body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return fastify.httpErrors.badRequest(`Invalid prompt retention config: ${issues}`);
      }

      const config = parsed.data;

      const row = await fastify.db.appSetting.upsert({
        where: { key: SETTINGS_KEY_PROMPT_RETENTION },
        update: { value: config as unknown as object },
        create: { key: SETTINGS_KEY_PROMPT_RETENTION, value: config as unknown as object },
      });

      return row.value as unknown as { fullRetentionDays: number; summaryRetentionDays: number };
    },
  );

  // ─── Super Admin ───

  // GET /api/settings/super-admin — get the designated super admin user ID
  fastify.get('/api/settings/super-admin', async () => {
    const setting = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_SUPER_ADMIN } });
    if (!setting || setting.value === null || setting.value === undefined) {
      return { userId: null };
    }
    if (typeof setting.value !== 'string') {
      logger.error({ value: setting.value, valueType: typeof setting.value }, 'Invalid super-admin setting value; expected string');
      return fastify.httpErrors.internalServerError('Invalid super admin setting value');
    }
    return { userId: setting.value };
  });

  // PUT /api/settings/super-admin — set the designated super admin user ID
  fastify.put<{ Body: { userId: string | null } }>('/api/settings/super-admin', async (request) => {
    if (request.body == null) {
      return fastify.httpErrors.badRequest('Request body is required');
    }

    const { userId } = request.body;

    if (userId === null) {
      await fastify.db.appSetting.deleteMany({ where: { key: SETTINGS_KEY_SUPER_ADMIN } });
      return { userId: null };
    }

    if (typeof userId !== 'string' || userId === '') {
      return fastify.httpErrors.badRequest('userId must be a non-empty string or null');
    }

    const user = await fastify.db.user.findUnique({ where: { id: userId } });
    if (!user) return fastify.httpErrors.notFound('User not found');
    if (!user.isActive) return fastify.httpErrors.badRequest('Super admin must be an active user');
    if (user.role !== 'ADMIN' && user.role !== 'OPERATOR') {
      return fastify.httpErrors.badRequest('Super admin must be an ADMIN or OPERATOR user');
    }

    await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_SUPER_ADMIN },
      create: { key: SETTINGS_KEY_SUPER_ADMIN, value: userId },
      update: { value: userId },
    });

    return { userId };
  });

  // ─── Action Safety Configuration ───

  /** Zod schema for validating a stored ActionSafetyConfig object. */
  const actionSafetyConfigSchema = z.object({
    actions: z.record(z.string().min(1), z.enum(['auto', 'approval'])),
  });

  // GET /api/settings/action-safety — get action safety config (upsert defaults on first access)
  fastify.get('/api/settings/action-safety', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_ACTION_SAFETY } });

    if (!row) {
      // Seed defaults on first access so subsequent GETs and the executor always find a row.
      await fastify.db.appSetting.upsert({
        where: { key: SETTINGS_KEY_ACTION_SAFETY },
        create: { key: SETTINGS_KEY_ACTION_SAFETY, value: DEFAULT_ACTION_SAFETY_CONFIG as unknown as object },
        update: { value: DEFAULT_ACTION_SAFETY_CONFIG as unknown as object },
      });
      return DEFAULT_ACTION_SAFETY_CONFIG;
    }

    // Validate the stored value; reset to defaults if malformed (e.g. from manual DB edits).
    const parsed = actionSafetyConfigSchema.safeParse(row.value);
    if (!parsed.success) {
      logger.warn({ key: SETTINGS_KEY_ACTION_SAFETY, errors: parsed.error.issues }, 'Stored action safety config is malformed — resetting to defaults');
      await fastify.db.appSetting.update({
        where: { key: SETTINGS_KEY_ACTION_SAFETY },
        data: { value: DEFAULT_ACTION_SAFETY_CONFIG as unknown as object },
      });
      return DEFAULT_ACTION_SAFETY_CONFIG;
    }

    return parsed.data as ActionSafetyConfig;
  });

  // PUT /api/settings/action-safety — update action safety config
  fastify.put<{ Body: ActionSafetyConfig }>('/api/settings/action-safety', async (request) => {
    const parsed = actionSafetyConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fastify.httpErrors.badRequest(`Invalid action safety config: ${msg}`);
    }

    const config: ActionSafetyConfig = parsed.data as ActionSafetyConfig;

    const row = await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_ACTION_SAFETY },
      update: { value: config as unknown as object },
      create: { key: SETTINGS_KEY_ACTION_SAFETY, value: config as unknown as object },
    });

    return row.value as unknown as ActionSafetyConfig;
  });

  // ─── Analysis Strategy Configuration ───

  const analysisStrategySchema = z.object({
    strategy: z.enum(['full_context', 'orchestrated']).default('full_context'),
    maxParallelTasks: z.coerce.number().int().min(1).max(10).default(3),
  });

  type AnalysisStrategyConfig = z.output<typeof analysisStrategySchema>;

  const DEFAULT_ANALYSIS_STRATEGY: AnalysisStrategyConfig = { strategy: 'full_context', maxParallelTasks: 3 };

  // GET /api/settings/analysis-strategy
  fastify.get('/api/settings/analysis-strategy', async () => {
    const row = await fastify.db.appSetting.findUnique({ where: { key: SETTINGS_KEY_ANALYSIS_STRATEGY } });
    if (!row) return DEFAULT_ANALYSIS_STRATEGY;

    const parsed = analysisStrategySchema.safeParse(row.value);
    if (!parsed.success) {
      logger.warn({ key: SETTINGS_KEY_ANALYSIS_STRATEGY, errors: parsed.error.issues }, 'Stored analysis strategy config is malformed — resetting to defaults');
      await fastify.db.appSetting.update({
        where: { key: SETTINGS_KEY_ANALYSIS_STRATEGY },
        data: { value: DEFAULT_ANALYSIS_STRATEGY as unknown as object },
      });
      return DEFAULT_ANALYSIS_STRATEGY;
    }

    return parsed.data;
  });

  // PUT /api/settings/analysis-strategy
  fastify.put<{ Body: Record<string, unknown> }>('/api/settings/analysis-strategy', async (request) => {
    const parsed = analysisStrategySchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return fastify.httpErrors.badRequest(`Invalid analysis strategy config: ${msg}`);
    }

    const config = parsed.data;

    const row = await fastify.db.appSetting.upsert({
      where: { key: SETTINGS_KEY_ANALYSIS_STRATEGY },
      update: { value: config as unknown as object },
      create: { key: SETTINGS_KEY_ANALYSIS_STRATEGY, value: config as unknown as object },
    });

    return row.value as AnalysisStrategyConfig;
  });
}
