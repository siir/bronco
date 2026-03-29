import type { FastifyInstance } from 'fastify';
import { createLogger, decrypt, looksEncrypted } from '@bronco/shared-utils';
import { ExternalServiceCheckType, IntegrationType } from '@bronco/shared-types';
import { normalizeUrl } from '../services/mcp-discovery.js';
import { sendRedisCommand } from '../services/redis.js';
import type { Config } from '../config.js';

const logger = createLogger('system-status');

const ServiceStatus = {
  UP: 'UP',
  DOWN: 'DOWN',
  DEGRADED: 'DEGRADED',
  UNKNOWN: 'UNKNOWN',
} as const;
type ServiceStatus = (typeof ServiceStatus)[keyof typeof ServiceStatus];

interface ComponentStatus {
  name: string;
  type: 'infrastructure' | 'service' | 'external';
  status: ServiceStatus;
  endpoint?: string;
  latencyMs?: number;
  uptime?: string;
  details?: Record<string, unknown>;
  configIssues?: string[];
  controllable: boolean;
}

interface DockerContainer {
  name: string;
  state: string;
  status: string;
  health?: string;
}

async function checkPostgres(db: FastifyInstance['db']): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const result: { now: Date; version: string }[] = await db.$queryRaw`SELECT now() AS "now", version() AS "version"`;
    const latencyMs = Date.now() - start;
    return {
      name: 'PostgreSQL',
      type: 'infrastructure',
      status: ServiceStatus.UP,
      endpoint: 'postgres:5432',
      latencyMs,
      details: {
        version: result[0]?.version?.split(',')[0] ?? 'unknown',
        serverTime: result[0]?.now,
      },
      controllable: true,
    };
  } catch (err) {
    return {
      name: 'PostgreSQL',
      type: 'infrastructure',
      status: ServiceStatus.DOWN,
      endpoint: 'postgres:5432',
      latencyMs: Date.now() - start,
      details: { error: (err as Error).message },
      controllable: true,
    };
  }
}

async function checkRedis(redisUrl: string): Promise<ComponentStatus> {
  const start = Date.now();
  try {
    const url = new URL(redisUrl);
    const host = url.hostname;
    const port = parseInt(url.port || '6379', 10);

    const response = await sendRedisCommand(host, port, ['PING', 'INFO server', 'INFO memory']);
    const latencyMs = Date.now() - start;

    const pong = response.includes('+PONG');
    const uptimeMatch = response.match(/uptime_in_seconds:(\d+)/);
    const versionMatch = response.match(/redis_version:(\S+)/);
    const usedMemMatch = response.match(/used_memory_human:(\S+)/);
    const maxMemMatch = response.match(/maxmemory_human:(\S+)/);

    const uptimeSec = uptimeMatch ? parseInt(uptimeMatch[1], 10) : undefined;

    return {
      name: 'Redis',
      type: 'infrastructure',
      status: pong ? ServiceStatus.UP : ServiceStatus.DEGRADED,
      endpoint: `${host}:${port}`,
      latencyMs,
      uptime: uptimeSec ? formatUptime(uptimeSec) : undefined,
      details: {
        version: versionMatch?.[1] ?? 'unknown',
        usedMemory: usedMemMatch?.[1] ?? 'unknown',
        maxMemory: maxMemMatch?.[1] ?? 'unknown',
      },
      controllable: true,
    };
  } catch (err) {
    return {
      name: 'Redis',
      type: 'infrastructure',
      status: ServiceStatus.DOWN,
      endpoint: redisUrl,
      latencyMs: Date.now() - start,
      details: { error: (err as Error).message },
      controllable: true,
    };
  }
}

async function checkHttpEndpoint(
  name: string,
  url: string,
  type: ComponentStatus['type'],
  controllable: boolean,
  timeoutMs = 5000,
): Promise<ComponentStatus> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const latencyMs = Date.now() - start;

    const details: Record<string, unknown> = { httpStatus: response.status };

    return {
      name,
      type,
      status: httpStatusToServiceStatus(response.status),
      endpoint: url,
      latencyMs,
      details,
      controllable,
    };
  } catch (err) {
    return {
      name,
      type,
      status: ServiceStatus.DOWN,
      endpoint: url,
      latencyMs: Date.now() - start,
      details: { error: (err as Error).message },
      controllable,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkOllama(name: string, ollamaBaseUrl: string, timeoutMs = 5000): Promise<ComponentStatus> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: controller.signal });
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        name,
        type: 'external',
        status: httpStatusToServiceStatus(response.status),
        endpoint: ollamaBaseUrl,
        latencyMs,
        details: { httpStatus: response.status },
        controllable: false,
      };
    }

    const body = await response.json() as { models?: { name: string; size: number }[] };
    const models = body.models?.map(m => m.name) ?? [];

    return {
      name,
      type: 'external',
      status: ServiceStatus.UP,
      endpoint: ollamaBaseUrl,
      latencyMs,
      details: {
        modelsLoaded: models.length,
        models,
      },
      configIssues: models.length === 0 ? ['No models loaded — pull a model with `ollama pull`'] : undefined,
      controllable: false,
    };
  } catch (err) {
    return {
      name,
      type: 'external',
      status: ServiceStatus.DOWN,
      endpoint: ollamaBaseUrl,
      latencyMs: Date.now() - start,
      details: { error: (err as Error).message },
      controllable: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getDockerContainers(): Promise<DockerContainer[]> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execFile);

    const { stdout } = await exec('docker', [
      'ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}',
    ], { timeout: 5000 });

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, state, status] = line.split('\t');
      const health = status.includes('(healthy)') ? 'healthy' :
        status.includes('(unhealthy)') ? 'unhealthy' :
        status.includes('(health: starting)') ? 'starting' : undefined;
      return { name, state, status, health };
    });
  } catch {
    return [];
  }
}

function getContainerUptime(containerName: string, containers: DockerContainer[]): string | undefined {
  const container = containers.find(c => c.name.includes(containerName));
  if (!container || container.state !== 'running') return undefined;
  return container.status;
}

function getContainerStatus(containerName: string, containers: DockerContainer[]): ServiceStatus {
  const container = containers.find(c => c.name.includes(containerName));
  if (!container) return ServiceStatus.UNKNOWN;
  if (container.state === 'running') {
    if (container.health === 'unhealthy') return ServiceStatus.DEGRADED;
    return ServiceStatus.UP;
  }
  if (container.state === 'restarting') return ServiceStatus.DEGRADED;
  return ServiceStatus.DOWN;
}

/**
 * Map an HTTP status code to a ServiceStatus.
 * 2xx/3xx → UP, 4xx → DEGRADED (reachable but misconfigured/unauthorized), 5xx → DOWN.
 */
function httpStatusToServiceStatus(statusCode: number): ServiceStatus {
  if (statusCode >= 200 && statusCode < 400) return ServiceStatus.UP;
  if (statusCode >= 400 && statusCode < 500) return ServiceStatus.DEGRADED;
  return ServiceStatus.DOWN;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function checkDockerService(
  name: string,
  containerName: string,
  containers: DockerContainer[],
  endpoint?: string,
  type: ComponentStatus['type'] = 'service',
): ComponentStatus {
  const status = getContainerStatus(containerName, containers);
  const uptime = getContainerUptime(containerName, containers);
  return {
    name,
    type,
    status,
    endpoint,
    uptime,
    controllable: type === 'service',
  };
}

/**
 * Check a worker service by probing its health HTTP endpoint.
 * Falls back to Docker container state if the health endpoint is unreachable.
 */
async function checkWorkerHealth(
  name: string,
  healthUrl: string,
  containerName: string,
  containers: DockerContainer[],
): Promise<ComponentStatus> {
  const start = Date.now();
  const dockerStatus = getContainerStatus(containerName, containers);
  const dockerUptime = getContainerUptime(containerName, containers);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${healthUrl}/health`, { signal: controller.signal });
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        name,
        type: 'service',
        status: httpStatusToServiceStatus(response.status),
        endpoint: healthUrl,
        latencyMs,
        uptime: dockerUptime,
        details: { httpStatus: response.status, dockerState: dockerStatus },
        controllable: true,
      };
    }

    const body = await response.json() as Record<string, unknown>;
    const { status: _, service: __, ...rest } = body;

    return {
      name,
      type: 'service',
      status: ServiceStatus.UP,
      endpoint: healthUrl,
      latencyMs,
      uptime: body.uptimeSeconds ? formatUptime(body.uptimeSeconds as number) : dockerUptime,
      details: rest,
      controllable: true,
    };
  } catch {
    // Health endpoint unreachable — fall back to Docker state
    return {
      name,
      type: 'service',
      status: dockerStatus === ServiceStatus.UP ? ServiceStatus.DEGRADED : dockerStatus,
      endpoint: healthUrl,
      latencyMs: Date.now() - start,
      uptime: dockerUptime,
      details: {
        healthEndpoint: 'unreachable',
        dockerState: dockerStatus,
      },
      controllable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getBullMQQueueStats(redisUrl: string): Promise<Record<string, unknown>> {
  try {
    const url = new URL(redisUrl);
    const host = url.hostname;
    const port = parseInt(url.port || '6379', 10);

    const queues = ['issue-resolve', 'log-summarize', 'email-ingestion', 'ticket-analysis', 'ticket-created', 'ticket-ingest', 'devops-sync', 'mcp-discovery', 'model-catalog-refresh', 'system-analysis', 'probe-execution'];
    const commands = queues.flatMap(q => [
      `LLEN bull:${q}:wait`,
      `LLEN bull:${q}:active`,
      `ZCARD bull:${q}:completed`,
      `ZCARD bull:${q}:failed`,
    ]);

    const response = await sendRedisCommand(host, port, commands);
    const numbers = response.match(/:(\d+)/g)?.map(m => parseInt(m.slice(1), 10)) ?? [];

    const stats: Record<string, unknown> = {};
    queues.forEach((q, i) => {
      const base = i * 4;
      stats[q] = {
        waiting: numbers[base] ?? 0,
        active: numbers[base + 1] ?? 0,
        completed: numbers[base + 2] ?? 0,
        failed: numbers[base + 3] ?? 0,
      };
    });
    return stats;
  } catch (err) {
    let safeRedisUrl: string | undefined;
    try { const u = new URL(redisUrl); u.username = ''; u.password = ''; safeRedisUrl = u.toString(); } catch { /* ignore */ }
    logger.warn({ err, redisUrl: safeRedisUrl ?? '[invalid]' }, 'Failed to retrieve BullMQ queue stats from Redis');
    return {};
  }
}

/**
 * Check a single external service based on its checkType.
 * Reads config from the ExternalService DB table.
 */
async function checkExternalService(
  svc: { name: string; endpoint: string; checkType: ExternalServiceCheckType; timeoutMs: number },
  containers: DockerContainer[],
): Promise<ComponentStatus> {
  switch (svc.checkType) {
    case ExternalServiceCheckType.OLLAMA:
      return checkOllama(svc.name, svc.endpoint, svc.timeoutMs);
    case ExternalServiceCheckType.DOCKER:
      return checkDockerService(svc.name, svc.endpoint, containers, svc.endpoint, 'external');
    case ExternalServiceCheckType.HTTP:
    default:
      return checkHttpEndpoint(svc.name, svc.endpoint, 'external', false, svc.timeoutMs);
  }
}

interface McpServerStatus {
  clientName: string;
  clientShortCode: string;
  label: string;
  status: ServiceStatus;
  endpoint: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
  integrationId?: string;
  serverName?: string | null;
  serverVersion?: string | null;
  tools?: Array<{ name: string; description: string }>;
  systemsCount?: number | null;
  lastVerifiedAt?: string | null;
  verificationStatus?: string | null;
  verificationError?: string | null;
}

interface McpIntegrationRow {
  id: string;
  label: string;
  config: { url?: string; healthPath?: string | null; apiKey?: string; authHeader?: string };
  metadata: Record<string, unknown> | null;
  client: { name: string; shortCode: string };
}

async function checkMcpServer(
  integration: McpIntegrationRow,
  encryptionKey: string,
  timeoutMs = 5000,
): Promise<McpServerStatus> {
  const rawUrl = integration.config.url ?? '';
  const { name: clientName, shortCode: clientShortCode } = integration.client;
  const metadata = integration.metadata as Record<string, unknown> | null;

  // Common metadata fields to include in every response (normalize null → undefined)
  const metadataFields = {
    integrationId: integration.id,
    serverName: (metadata?.serverName ?? undefined) as string | undefined,
    serverVersion: (metadata?.serverVersion ?? undefined) as string | undefined,
    tools: (metadata?.tools ?? undefined) as Array<{ name: string; description: string }> | undefined,
    systemsCount: (metadata?.systemsCount ?? undefined) as number | undefined,
    lastVerifiedAt: (metadata?.lastVerifiedAt ?? undefined) as string | undefined,
    verificationStatus: (metadata?.verificationStatus ?? undefined) as string | undefined,
    verificationError: (metadata?.verificationError ?? undefined) as string | undefined,
  };

  if (!rawUrl) {
    return {
      clientName,
      clientShortCode,
      label: integration.label,
      status: ServiceStatus.DOWN,
      endpoint: '(not configured)',
      details: { error: 'MCP_DATABASE integration has no url in config' },
      ...metadataFields,
    };
  }

  let baseUrl: string;
  try {
    baseUrl = normalizeUrl(rawUrl);
    // Validate the normalized URL is parseable
    new URL(baseUrl);
  } catch (err) {
    return {
      clientName,
      clientShortCode,
      label: integration.label,
      status: ServiceStatus.DOWN,
      endpoint: rawUrl,
      details: {
        error: 'Invalid base URL for MCP_DATABASE integration',
        rawUrl,
        message: err instanceof Error ? err.message : String(err),
      },
      ...metadataFields,
    };
  }

  // Health path: default '/health', null to disable health checks
  const healthPath = integration.config.healthPath;
  if (healthPath === null) {
    return {
      clientName,
      clientShortCode,
      label: integration.label,
      status: ServiceStatus.UNKNOWN,
      endpoint: baseUrl,
      details: { note: 'Health checks disabled for this integration' },
      ...metadataFields,
    };
  }

  // Reject absolute URLs and scheme-relative URLs in healthPath (SSRF mitigation)
  if (healthPath && (healthPath.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(healthPath))) {
    return {
      clientName,
      clientShortCode,
      label: integration.label,
      status: ServiceStatus.DOWN,
      endpoint: baseUrl,
      details: {
        error: 'healthPath must be a relative path, not an absolute URL',
        healthPath,
      },
      ...metadataFields,
    };
  }

  const start = Date.now();
  let healthUrl: string;
  try {
    healthUrl = new URL(healthPath ?? '/health', baseUrl).href;
  } catch (err) {
    return {
      clientName,
      clientShortCode,
      label: integration.label,
      status: ServiceStatus.DOWN,
      endpoint: baseUrl,
      details: {
        error: 'Invalid health URL for MCP_DATABASE integration',
        baseUrl,
        healthPath: healthPath ?? '/health',
        message: err instanceof Error ? err.message : String(err),
      },
      ...metadataFields,
    };
  }
  const fetchHeaders: Record<string, string> = {};
  if (integration.config.apiKey) {
    const raw = integration.config.apiKey;
    let apiKey = raw;
    if (looksEncrypted(raw)) {
      try {
        apiKey = decrypt(raw, encryptionKey);
      } catch {
        logger.warn(
          { integrationId: integration.id, clientShortCode },
          'Failed to decrypt MCP_DATABASE apiKey; using raw value',
        );
      }
    }
    if (integration.config.authHeader === 'x-api-key') {
      fetchHeaders['X-Api-Key'] = apiKey;
    } else {
      fetchHeaders['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      signal: controller.signal,
      headers: Object.keys(fetchHeaders).length > 0 ? fetchHeaders : undefined,
    });
    const latencyMs = Date.now() - start;

    if (!response.ok) {
      return {
        clientName,
        clientShortCode,
        label: integration.label,
        status: httpStatusToServiceStatus(response.status),
        endpoint: baseUrl,
        latencyMs,
        details: { httpStatus: response.status },
        ...metadataFields,
      };
    }

    // Any 200 OK response is treated as UP — status is not downgraded based on body content.
    // Body is parsed only to enrich details (e.g. Azure App Service returns "Healthy" as
    // text/plain; other endpoints return {"status":"ok"} JSON — both are healthy).
    let details: Record<string, unknown> | undefined;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        const body = await response.json() as Record<string, unknown>;
        details = body.timestamp ? { serverTime: body.timestamp } : undefined;
      } catch (parseError) {
        // JSON parse failed despite content-type — still 200, treat as UP, but log for diagnosis
        logger.warn(
          {
            clientShortCode,
            label: integration.label,
            endpoint: baseUrl,
            contentType,
            parseError: parseError instanceof Error ? parseError.message : String(parseError),
          },
          'Failed to parse JSON from health endpoint despite application/json content-type',
        );
        details = { jsonParseError: 'Failed to parse JSON from health endpoint; see logs for details.' };
      }
    }

    return {
      clientName,
      clientShortCode,
      label: integration.label,
      status: ServiceStatus.UP,
      endpoint: baseUrl,
      latencyMs,
      details,
      ...metadataFields,
    };
  } catch (err) {
    return {
      clientName,
      clientShortCode,
      label: integration.label,
      status: ServiceStatus.DOWN,
      endpoint: baseUrl,
      latencyMs: Date.now() - start,
      details: { error: (err as Error).message },
      ...metadataFields,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check an LLM provider's connectivity based on its type and base URL.
 */
async function checkLlmProvider(
  provider: { name: string; provider: string; baseUrl: string | null; model: string },
  timeoutMs = 5000,
): Promise<ComponentStatus> {
  const start = Date.now();
  const providerType = provider.provider.toUpperCase();

  // LOCAL/Ollama — check /api/tags
  if (providerType === 'LOCAL' && provider.baseUrl) {
    return checkOllama(`LLM: ${provider.name}`, provider.baseUrl, timeoutMs);
  }

  // For cloud providers (CLAUDE, OPENAI, GROK, GOOGLE), check base URL reachability
  const DEFAULT_BASE_URLS: Record<string, string> = {
    CLAUDE: 'https://api.anthropic.com',
    OPENAI: 'https://api.openai.com',
    GROK: 'https://api.x.ai',
    GOOGLE: 'https://generativelanguage.googleapis.com',
  };
  const baseUrl = provider.baseUrl ?? DEFAULT_BASE_URLS[providerType] ?? null;

  if (!baseUrl) {
    return {
      name: `LLM: ${provider.name}`,
      type: 'external',
      status: ServiceStatus.UNKNOWN,
      details: { note: 'No base URL configured', model: provider.model },
      controllable: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl, {
      method: 'HEAD',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;

    // For LLM reachability checks, any HTTP response (<500) proves the server
    // is reachable. Cloud API base URLs typically return 401/404 for
    // unauthenticated requests, which is expected — not degraded.
    const status = response.status >= 500 ? ServiceStatus.DOWN : ServiceStatus.UP;

    return {
      name: `LLM: ${provider.name}`,
      type: 'external',
      status,
      endpoint: baseUrl,
      latencyMs,
      details: { model: provider.model, httpStatus: response.status },
      controllable: false,
    };
  } catch (err) {
    return {
      name: `LLM: ${provider.name}`,
      type: 'external',
      status: ServiceStatus.DOWN,
      endpoint: baseUrl,
      latencyMs: Date.now() - start,
      details: { model: provider.model, error: (err as Error).message },
      controllable: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface SystemStatusOpts {
  config: Config;
}

export async function systemStatusRoutes(
  fastify: FastifyInstance,
  opts: SystemStatusOpts,
): Promise<void> {
  // GET /api/system-status — full system status
  fastify.get('/api/system-status', async () => {
    const [containers, externalServices, mcpIntegrations, llmProviders] = await Promise.all([
      getDockerContainers(),
      fastify.db.externalService.findMany({ where: { isMonitored: true }, orderBy: { createdAt: 'asc' } }),
      fastify.db.clientIntegration.findMany({
        where: { type: IntegrationType.MCP_DATABASE, isActive: true, client: { isActive: true } },
        select: { id: true, label: true, config: true, metadata: true, client: { select: { name: true, shortCode: true } } },
        orderBy: { client: { name: 'asc' } },
      }),
      fastify.db.aiProvider.findMany({
        where: { isActive: true },
        include: { models: { where: { isActive: true }, orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Start MCP checks concurrently with the main health checks (not sequentially after).
    // Each check is wrapped in try/catch so one bad config doesn't crash all checks.
    const mcpPromise = Promise.all(
      mcpIntegrations.map(async (i): Promise<McpServerStatus> => {
        const cfg = typeof i.config === 'object' && i.config !== null && !Array.isArray(i.config) ? i.config as Record<string, unknown> : {};
        const meta = typeof i.metadata === 'object' && i.metadata !== null && !Array.isArray(i.metadata) ? i.metadata as Record<string, unknown> : null;
        try {
          return await checkMcpServer({
            id: i.id,
            label: i.label,
            config: {
              url: typeof cfg['url'] === 'string' ? cfg['url'] : undefined,
              healthPath: cfg['healthPath'] === null ? null : (typeof cfg['healthPath'] === 'string' ? cfg['healthPath'] : undefined),
              apiKey: typeof cfg['apiKey'] === 'string' ? cfg['apiKey'] : undefined,
              authHeader: typeof cfg['authHeader'] === 'string' ? cfg['authHeader'] : undefined,
            },
            metadata: meta,
            client: i.client,
          }, opts.config.ENCRYPTION_KEY);
        } catch (err) {
          logger.warn({ err, integrationId: i.id }, 'MCP server health check failed unexpectedly');
          return {
            clientName: i.client.name,
            clientShortCode: i.client.shortCode,
            label: i.label,
            status: ServiceStatus.DOWN,
            endpoint: typeof cfg['url'] === 'string' ? cfg['url'] : '(unknown)',
            details: { error: err instanceof Error ? err.message : String(err) },
            integrationId: i.id,
          };
        }
      }),
    );

    // Run LLM provider checks concurrently with other checks
    // Flatten providers × models into the shape checkLlmProvider expects
    const llmFlattened = llmProviders.flatMap(p =>
      (p.models as Array<{ name: string; model: string }>).map(m => ({
        name: m.name,
        provider: p.provider,
        baseUrl: p.baseUrl,
        model: m.model,
      })),
    );
    const llmPromise = Promise.all(llmFlattened.map(p => checkLlmProvider(p)));

    const [
      postgres,
      redis,
      imapWorker,
      devopsWorker,
      issueResolver,
      statusMonitor,
      ticketAnalyzer,
      probeWorker,
      queueStats,
      ...externalResults
    ] = await Promise.all([
      checkPostgres(fastify.db),
      checkRedis(opts.config.REDIS_URL),
      checkWorkerHealth('IMAP Worker', opts.config.IMAP_WORKER_HEALTH_URL, 'imap-worker', containers),
      checkWorkerHealth('DevOps Worker', opts.config.DEVOPS_WORKER_HEALTH_URL, 'devops-worker', containers),
      checkWorkerHealth('Issue Resolver', opts.config.ISSUE_RESOLVER_HEALTH_URL, 'issue-resolver', containers),
      checkWorkerHealth('Status Monitor', opts.config.STATUS_MONITOR_HEALTH_URL, 'status-monitor', containers),
      checkWorkerHealth('Ticket Analyzer', opts.config.TICKET_ANALYZER_HEALTH_URL, 'ticket-analyzer', containers),
      checkWorkerHealth('Probe Worker', opts.config.PROBE_WORKER_HEALTH_URL, 'probe-worker', containers),
      getBullMQQueueStats(opts.config.REDIS_URL),
      ...externalServices.map(svc => checkExternalService(svc, containers)),
    ]);

    const [mcpResults, llmResults] = await Promise.all([mcpPromise, llmPromise]);
    logger.debug({ mcpCount: mcpResults.length, llmCount: llmResults.length }, 'MCP + LLM health checks completed');

    // Config issue detection
    const configIssues: string[] = [];
    const components: ComponentStatus[] = [
      postgres,
      redis,
      {
        name: 'Copilot API',
        type: 'service',
        status: ServiceStatus.UP,
        endpoint: `http://localhost:${opts.config.PORT}/api`,
        details: { note: 'This service (responding to this request)' },
        controllable: true,
      },
      imapWorker,
      issueResolver,
      devopsWorker,
      statusMonitor,
      ticketAnalyzer,
      probeWorker,
      ...externalResults,
    ];

    // Include MCP servers and LLM providers in overall status calculation
    const allStatuses = [
      ...components.map(c => c.status),
      ...mcpResults.map(m => m.status),
      ...llmResults.map(l => l.status),
    ];
    const anyDown = allStatuses.some(s => s === ServiceStatus.DOWN);
    const allUp = allStatuses.every(s => s === ServiceStatus.UP || s === ServiceStatus.UNKNOWN);
    const overallStatus = anyDown ? ServiceStatus.DEGRADED : allUp ? ServiceStatus.UP : ServiceStatus.DEGRADED;

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      components,
      mcpServers: mcpResults,
      llmProviders: llmResults,
      queueStats,
      configIssues: configIssues.length > 0 ? configIssues : undefined,
    };
  });

  // POST /api/system-status/control — start/stop/restart a Docker service
  fastify.post<{
    Body: {
      service: string;
      action: 'start' | 'stop' | 'restart';
    };
  }>('/api/system-status/control', async (request, reply) => {
    const { service, action } = request.body;

    // Whitelist of controllable Docker Compose services
    const allowedServices: Record<string, string> = {
      'copilot-api': 'copilot-api',
      'imap-worker': 'imap-worker',
      'issue-resolver': 'issue-resolver',
      'devops-worker': 'devops-worker',
      'status-monitor': 'status-monitor',
      'ticket-analyzer': 'ticket-analyzer',
      'probe-worker': 'probe-worker',
      'caddy': 'caddy',
      'postgres': 'postgres',
      'redis': 'redis',
    };

    const composeService = allowedServices[service];
    if (!composeService) {
      return reply.code(400).send({
        error: `Unknown or uncontrollable service: ${service}. Allowed: ${Object.keys(allowedServices).join(', ')}`,
      });
    }

    if (!['start', 'stop', 'restart'].includes(action)) {
      return reply.code(400).send({
        error: `Invalid action: ${action}. Allowed: start, stop, restart`,
      });
    }

    // Warn about self-restart
    if (service === 'copilot-api' && (action === 'stop' || action === 'restart')) {
      logger.warn({ service, action }, 'Self-restart/stop requested — API will be temporarily unavailable');
    }

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const exec = promisify(execFile);

      const { stdout, stderr } = await exec('docker', [
        'compose', action, composeService,
      ], { timeout: 30000 });

      logger.info({ service: composeService, action, stdout: stdout.trim() }, 'Docker compose control executed');

      return {
        success: true,
        service: composeService,
        action,
        message: `${action} command sent to ${composeService}`,
        output: (stdout + stderr).trim() || undefined,
      };
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err, service: composeService, action }, 'Docker compose control failed');
      return reply.code(500).send({
        error: `Failed to ${action} ${composeService}: ${message}`,
      });
    }
  });
}
