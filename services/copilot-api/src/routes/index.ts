import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import type { AIRouter, ClientMemoryResolver, ModelConfigResolver, ProviderConfigResolver } from '@bronco/ai-provider';
import type { TicketCreatedJob, IngestionJob } from '@bronco/shared-types';
import { UserRole } from '@bronco/shared-types';
import type { Config } from '../config.js';
import { requireRole } from '../plugins/auth.js';
import { healthRoutes } from './health.js';
import { clientRoutes } from './clients.js';
import { contactRoutes } from './contacts.js';
import { systemRoutes } from './systems.js';
import { ticketRoutes } from './tickets.js';
import { artifactRoutes } from './artifacts.js';
import { repoRoutes } from './repos.js';
import { issueJobRoutes } from './issue-jobs.js';
import { integrationRoutes } from './integrations.js';
import { externalServiceRoutes } from './external-services.js';
import { promptRoutes } from './prompts.js';
import { keywordRoutes } from './keywords.js';
import { aiConfigRoutes } from './ai-config.js';
import { aiProviderRoutes } from './ai-providers.js';
import { authRoutes } from './auth.js';
import { logRoutes } from './logs.js';
import { logSummaryRoutes } from './log-summaries.js';
import { systemStatusRoutes } from './system-status.js';
import { aiUsageRoutes } from './ai-usage.js';
import { systemAnalysisRoutes } from './system-analyses.js';
import { systemIssuesRoutes } from './system-issues.js';
import { notificationChannelRoutes } from './notification-channels.js';
import { settingsRoutes } from './settings.js';
import { releaseNoteRoutes } from './release-notes.js';
import { operationalTaskRoutes } from './operational-tasks.js';
import { ticketRouteRoutes } from './ticket-routes.js';
import { clientMemoryRoutes } from './client-memory.js';
import { clientEnvironmentRoutes } from './client-environments.js';
import { portalAuthRoutes } from './portal-auth.js';
import { portalTicketRoutes } from './portal-tickets.js';
import { portalUserRoutes } from './portal-users.js';
import { clientUserRoutes } from './client-users.js';
import { clientAiCredentialRoutes } from './client-ai-credentials.js';
import { userRoutes } from './users.js';
import { scheduledProbeRoutes } from './scheduled-probes.js';
import { ticketFilterPresetRoutes } from './ticket-filter-presets.js';
import { ingestRoutes } from './ingest.js';
import { invoiceRoutes } from './invoices.js';
import { failedJobRoutes } from './failed-jobs.js';
import { emailLogRoutes } from './email-logs.js';
import { operatorRoutes } from './operators.js';
import { notificationPreferenceRoutes } from './notification-preferences.js';

interface RouteOpts {
  config: Config;
  issueResolveQueue: Queue;
  logSummarizeQueue: Queue;
  systemAnalysisQueue: Queue;
  mcpDiscoveryQueue: Queue;
  probeQueue: Queue;
  ticketCreatedQueue: Queue<TicketCreatedJob>;
  ingestQueue: Queue<IngestionJob>;
  queueMap: Map<string, Queue>;
  ai: AIRouter;
  clientMemoryResolver: ClientMemoryResolver;
  modelConfigResolver: ModelConfigResolver;
  providerConfigResolver: ProviderConfigResolver;
  onSlackIntegrationChange?: () => void;
}

export async function registerRoutes(fastify: FastifyInstance, opts: RouteOpts): Promise<void> {
  // Public / self-service routes (auth handled at plugin level)
  await fastify.register(authRoutes);
  await fastify.register(healthRoutes, { config: opts.config });

  // Portal routes — client user auth (separate JWT, handled at plugin level)
  await fastify.register(portalAuthRoutes);
  await fastify.register(portalTicketRoutes, { config: opts.config, ticketCreatedQueue: opts.ticketCreatedQueue, ingestQueue: opts.ingestQueue });
  await fastify.register(portalUserRoutes);

  // Control panel routes — require ADMIN or OPERATOR role.
  // API-key callers (service-to-service) pass through; only JWT-authenticated
  // CLIENT users are blocked.
  const controlPanelGuard = requireRole(UserRole.ADMIN, UserRole.OPERATOR);

  await fastify.register(async (scoped) => {
    scoped.addHook('preHandler', controlPanelGuard);

    await scoped.register(clientRoutes);
    await scoped.register(contactRoutes);
    await scoped.register(systemRoutes);
    await scoped.register(ticketRoutes, { logSummarizeQueue: opts.logSummarizeQueue, systemAnalysisQueue: opts.systemAnalysisQueue, ticketCreatedQueue: opts.ticketCreatedQueue, ingestQueue: opts.ingestQueue, ai: opts.ai });
    await scoped.register(artifactRoutes, { config: opts.config });
    await scoped.register(repoRoutes);
    await scoped.register(issueJobRoutes, { issueResolveQueue: opts.issueResolveQueue });
    await scoped.register(integrationRoutes, { encryptionKey: opts.config.ENCRYPTION_KEY, mcpDiscoveryQueue: opts.mcpDiscoveryQueue, onSlackIntegrationChange: opts.onSlackIntegrationChange });
    await scoped.register(externalServiceRoutes);
    await scoped.register(logRoutes);
    await scoped.register(logSummaryRoutes, { ai: opts.ai });
    await scoped.register(promptRoutes);
    await scoped.register(keywordRoutes);
    await scoped.register(aiConfigRoutes, { modelConfigResolver: opts.modelConfigResolver, ai: opts.ai });
    await scoped.register(aiProviderRoutes, { providerConfigResolver: opts.providerConfigResolver, encryptionKey: opts.config.ENCRYPTION_KEY });
    await scoped.register(systemStatusRoutes, { config: opts.config });
    await scoped.register(aiUsageRoutes, { ai: opts.ai });
    await scoped.register(systemAnalysisRoutes, { systemAnalysisQueue: opts.systemAnalysisQueue });
    await scoped.register(systemIssuesRoutes, { redisUrl: opts.config.REDIS_URL });
    await scoped.register(notificationChannelRoutes, { encryptionKey: opts.config.ENCRYPTION_KEY });
    await scoped.register(settingsRoutes, { encryptionKey: opts.config.ENCRYPTION_KEY });
    await scoped.register(releaseNoteRoutes, { config: opts.config, ai: opts.ai });
    await scoped.register(operationalTaskRoutes);
    await scoped.register(ticketRouteRoutes, { ai: opts.ai });
    await scoped.register(clientMemoryRoutes, { clientMemoryResolver: opts.clientMemoryResolver });
    await scoped.register(clientEnvironmentRoutes);
    await scoped.register(clientUserRoutes);
    await scoped.register(clientAiCredentialRoutes, { encryptionKey: opts.config.ENCRYPTION_KEY });
    await scoped.register(userRoutes);
    await scoped.register(scheduledProbeRoutes, { probeQueue: opts.probeQueue });
    await scoped.register(ticketFilterPresetRoutes);
    await scoped.register(ingestRoutes, { ingestQueue: opts.ingestQueue });
    await scoped.register(invoiceRoutes, { invoiceStoragePath: opts.config.INVOICE_STORAGE_PATH });
    await scoped.register(failedJobRoutes, { queueMap: opts.queueMap });
    await scoped.register(emailLogRoutes);
    await scoped.register(operatorRoutes);
    await scoped.register(notificationPreferenceRoutes);
  });
}
