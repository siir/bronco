import type { FastifyInstance } from 'fastify';
import { AIProvider, CapabilityLevel, AppScope, APP_SCOPE_LABELS } from '@bronco/shared-types';
import { encrypt } from '@bronco/shared-utils';
import type { ProviderConfigResolver } from '@bronco/ai-provider';
import { TASK_CAPABILITY_REQUIREMENTS, CAPABILITY_LEVEL_ORDER } from '@bronco/ai-provider';

const VALID_PROVIDERS = new Set<string>(Object.values(AIProvider));
const VALID_CAPABILITIES = new Set<string>(Object.values(CapabilityLevel));
const VALID_APP_SCOPES = new Set<string>(Object.values(AppScope));

/** Providers with a working client implementation in AIRouter. */
const ROUTABLE_PROVIDERS = new Set<string>([AIProvider.LOCAL, AIProvider.CLAUDE, AIProvider.OPENAI, AIProvider.GROK]);

/** Display labels for each known provider. */
const PROVIDER_LABELS: Record<AIProvider, string> = {
  [AIProvider.LOCAL]: 'LOCAL (Ollama)',
  [AIProvider.CLAUDE]: 'CLAUDE (Anthropic)',
  [AIProvider.OPENAI]: 'OPENAI',
  [AIProvider.GROK]: 'GROK (xAI)',
  [AIProvider.GOOGLE]: 'GOOGLE (Gemini)',
};

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

interface AiProviderRouteOpts {
  providerConfigResolver: ProviderConfigResolver;
  encryptionKey: string;
}

export async function aiProviderRoutes(
  fastify: FastifyInstance,
  opts: AiProviderRouteOpts,
): Promise<void> {
  const { providerConfigResolver, encryptionKey } = opts;

  /** Redact encrypted key and strip raw models relation — return only hasApiKey boolean. */
  function redactProvider(row: Record<string, unknown>) {
    const { encryptedApiKey, models: _models, ...rest } = row;
    return { ...rest, hasApiKey: !!encryptedApiKey };
  }

  /** Denormalize a model row that was fetched with `include: { provider: true }`. */
  function mapModel(row: Record<string, unknown>) {
    const p = row.provider as { provider: string; isActive: boolean; encryptedApiKey: string | null; baseUrl: string | null };
    const { provider: _p, ...rest } = row;
    return {
      ...rest,
      provider: p.provider,
      providerActive: p.isActive,
      hasApiKey: !!p.encryptedApiKey,
      baseUrl: p.baseUrl,
    };
  }

  // ───────── Provider endpoints ─────────

  // GET /api/ai-providers/app-scopes — available app scopes with display labels
  fastify.get('/api/ai-providers/app-scopes', async () => {
    return Object.values(AppScope).map((value) => ({
      value,
      label: APP_SCOPE_LABELS[value],
    }));
  });

  // GET /api/ai-providers — list all providers (with model counts)
  fastify.get('/api/ai-providers', async () => {
    const rows = await fastify.db.aiProvider.findMany({
      include: { models: { select: { id: true, isActive: true } } },
      orderBy: [{ provider: 'asc' }],
    });
    return rows.map((r) => {
      const redacted = redactProvider(r as unknown as Record<string, unknown>);
      const models = r.models as Array<{ id: string; isActive: boolean }>;
      return {
        ...redacted,
        modelCount: models.length,
        activeModelCount: models.filter((m) => m.isActive).length,
      };
    });
  });

  // GET /api/ai-providers/capabilities
  fastify.get('/api/ai-providers/capabilities', async () => {
    return TASK_CAPABILITY_REQUIREMENTS;
  });

  // GET /api/ai-providers/types — known provider types with display labels
  fastify.get('/api/ai-providers/types', async () => {
    return Object.values(AIProvider).map((value) => ({
      value,
      label: PROVIDER_LABELS[value] ?? value,
      routable: ROUTABLE_PROVIDERS.has(value),
    }));
  });

  // GET /api/ai-providers/:id — single provider with model counts
  fastify.get<{ Params: { id: string } }>(
    '/api/ai-providers/:id',
    async (request) => {
      const row = await fastify.db.aiProvider.findUnique({
        where: { id: request.params.id },
        include: { models: { select: { id: true, isActive: true } } },
      });
      if (!row) return fastify.httpErrors.notFound('AI provider not found');
      const redacted = redactProvider(row as unknown as Record<string, unknown>);
      const models = row.models as Array<{ id: string; isActive: boolean }>;
      return {
        ...redacted,
        modelCount: models.length,
        activeModelCount: models.filter((m) => m.isActive).length,
      };
    },
  );

  // POST /api/ai-providers — create a new provider
  fastify.post<{
    Body: {
      provider: string;
      baseUrl?: string;
      apiKey?: string;
    };
  }>('/api/ai-providers', async (request, reply) => {
    const { provider, baseUrl, apiKey } = request.body;

    if (!VALID_PROVIDERS.has(provider)) {
      return fastify.httpErrors.badRequest(`Invalid provider "${provider}". Valid: ${[...VALID_PROVIDERS].join(', ')}.`);
    }
    if (provider === AIProvider.LOCAL && !baseUrl?.trim()) {
      return fastify.httpErrors.badRequest('baseUrl is required for LOCAL providers.');
    }
    if (provider !== AIProvider.LOCAL && !apiKey?.trim()) {
      return fastify.httpErrors.badRequest('apiKey is required for API-based providers.');
    }

    const encryptedApiKey = apiKey ? encrypt(apiKey, encryptionKey) : null;

    try {
      const row = await fastify.db.aiProvider.create({
        data: {
          provider,
          baseUrl: baseUrl?.trim() ?? null,
          encryptedApiKey,
        },
      });
      providerConfigResolver.invalidate();
      reply.code(201);
      return redactProvider(row as unknown as Record<string, unknown>);
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(`A provider of type "${provider}" already exists.`);
      }
      throw err;
    }
  });

  // PATCH /api/ai-providers/:id — update provider settings
  fastify.patch<{
    Params: { id: string };
    Body: {
      baseUrl?: string | null;
      apiKey?: string;
      isActive?: boolean;
    };
  }>('/api/ai-providers/:id', async (request) => {
    const { baseUrl, apiKey, isActive } = request.body;

    const data: Record<string, unknown> = {};
    if (baseUrl !== undefined) {
      const existing = await fastify.db.aiProvider.findUnique({
        where: { id: request.params.id },
        select: { provider: true },
      });
      if (!existing) return fastify.httpErrors.notFound('AI provider not found');
      if (existing.provider === AIProvider.LOCAL && !baseUrl?.trim()) {
        return fastify.httpErrors.badRequest('baseUrl is required for LOCAL providers.');
      }
      data.baseUrl = baseUrl?.trim() ?? null;
    }
    if (isActive !== undefined) data.isActive = isActive;
    if (apiKey !== undefined) {
      data.encryptedApiKey = apiKey ? encrypt(apiKey, encryptionKey) : null;
    }

    try {
      const row = await fastify.db.aiProvider.update({
        where: { id: request.params.id },
        data,
      });
      providerConfigResolver.invalidate();
      return redactProvider(row as unknown as Record<string, unknown>);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('AI provider not found');
      }
      throw err;
    }
  });

  // DELETE /api/ai-providers/:id — delete provider and all its models (cascade)
  fastify.delete<{ Params: { id: string } }>(
    '/api/ai-providers/:id',
    async (request, reply) => {
      try {
        await fastify.db.aiProvider.delete({
          where: { id: request.params.id },
        });
        providerConfigResolver.invalidate();
        reply.code(204);
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('AI provider not found');
        }
        throw err;
      }
    },
  );

  // POST /api/ai-providers/:id/test — test provider connectivity
  fastify.post<{ Params: { id: string } }>(
    '/api/ai-providers/:id/test',
    async (request) => {
      const row = await fastify.db.aiProvider.findUnique({
        where: { id: request.params.id },
      });
      if (!row) return fastify.httpErrors.notFound('AI provider not found');

      if (row.provider === AIProvider.LOCAL) {
        if (!row.baseUrl) return { success: false, error: 'No base URL configured' };
        try {
          const res = await fetch(`${row.baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
          return { success: true };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Connection failed' };
        }
      }

      // All non-LOCAL providers are API-key based
      if (!row.encryptedApiKey) return { success: false, error: 'No API key configured' };
      return { success: true, note: 'API key is stored. Full validation requires a live API call.' };
    },
  );

  // ───────── Model endpoints ─────────

  // GET /api/ai-providers/models — list all models (flattened with provider info)
  fastify.get('/api/ai-providers/models', async () => {
    const rows = await fastify.db.aiProviderModel.findMany({
      include: { provider: true },
      orderBy: [{ name: 'asc' }],
    });
    // Sort by capability hierarchy then name
    const sorted = rows.sort((a, b) => {
      const aIdx = CAPABILITY_LEVEL_ORDER.indexOf(a.capabilityLevel);
      const bIdx = CAPABILITY_LEVEL_ORDER.indexOf(b.capabilityLevel);
      if (aIdx !== bIdx) return aIdx - bIdx;
      return a.name.localeCompare(b.name);
    });
    return sorted.map((r) => mapModel(r as unknown as Record<string, unknown>));
  });

  // GET /api/ai-providers/models/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/ai-providers/models/:id',
    async (request) => {
      const row = await fastify.db.aiProviderModel.findUnique({
        where: { id: request.params.id },
        include: { provider: true },
      });
      if (!row) return fastify.httpErrors.notFound('AI provider model not found');
      return mapModel(row as unknown as Record<string, unknown>);
    },
  );

  // POST /api/ai-providers/models — create a new model under a provider
  fastify.post<{
    Body: {
      providerId: string;
      name: string;
      model: string;
      capabilityLevel?: string;
      enabledApps?: string[];
    };
  }>('/api/ai-providers/models', async (request, reply) => {
    const { providerId, name, model, capabilityLevel, enabledApps } = request.body;

    if (!name?.trim()) return fastify.httpErrors.badRequest('name is required');
    if (!model?.trim()) return fastify.httpErrors.badRequest('model is required');
    if (!providerId) return fastify.httpErrors.badRequest('providerId is required');
    if (capabilityLevel && !VALID_CAPABILITIES.has(capabilityLevel)) {
      return fastify.httpErrors.badRequest(`Invalid capability level "${capabilityLevel}".`);
    }
    if (enabledApps) {
      const invalid = enabledApps.filter((a) => !VALID_APP_SCOPES.has(a));
      if (invalid.length > 0) {
        return fastify.httpErrors.badRequest(`Invalid app scopes: ${invalid.join(', ')}. Valid: ${[...VALID_APP_SCOPES].join(', ')}.`);
      }
    }

    // Verify provider exists
    const provider = await fastify.db.aiProvider.findUnique({ where: { id: providerId } });
    if (!provider) return fastify.httpErrors.badRequest('Provider not found');

    try {
      const row = await fastify.db.aiProviderModel.create({
        data: {
          providerId,
          name: name.trim(),
          model: model.trim(),
          capabilityLevel: capabilityLevel ?? 'STANDARD',
          enabledApps: enabledApps ?? [],
        },
        include: { provider: true },
      });
      providerConfigResolver.invalidate();
      reply.code(201);
      return mapModel(row as unknown as Record<string, unknown>);
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A model with this name already exists.');
      }
      throw err;
    }
  });

  // PATCH /api/ai-providers/models/:id — update model
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      model?: string;
      capabilityLevel?: string;
      isActive?: boolean;
      enabledApps?: string[];
      providerId?: string;
    };
  }>('/api/ai-providers/models/:id', async (request) => {
    const { name, model, capabilityLevel, isActive, enabledApps, providerId } = request.body;

    if (capabilityLevel && !VALID_CAPABILITIES.has(capabilityLevel)) {
      return fastify.httpErrors.badRequest(`Invalid capability level "${capabilityLevel}".`);
    }
    if (name !== undefined && !name.trim()) {
      return fastify.httpErrors.badRequest('name cannot be empty.');
    }
    if (model !== undefined && !model.trim()) {
      return fastify.httpErrors.badRequest('model cannot be empty.');
    }
    if (enabledApps !== undefined) {
      if (!Array.isArray(enabledApps)) {
        return fastify.httpErrors.badRequest('enabledApps must be an array.');
      }
      const invalid = enabledApps.filter((a) => !VALID_APP_SCOPES.has(a));
      if (invalid.length > 0) {
        return fastify.httpErrors.badRequest(`Invalid app scopes: ${invalid.join(', ')}. Valid: ${[...VALID_APP_SCOPES].join(', ')}.`);
      }
    }
    if (providerId) {
      const provider = await fastify.db.aiProvider.findUnique({ where: { id: providerId } });
      if (!provider) return fastify.httpErrors.badRequest('Provider not found');
    }

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (model !== undefined) data.model = model.trim();
    if (capabilityLevel !== undefined) data.capabilityLevel = capabilityLevel;
    if (isActive !== undefined) data.isActive = isActive;
    if (enabledApps !== undefined) data.enabledApps = enabledApps;
    if (providerId !== undefined) data.providerId = providerId;

    try {
      const row = await fastify.db.aiProviderModel.update({
        where: { id: request.params.id },
        data,
        include: { provider: true },
      });
      providerConfigResolver.invalidate();
      return mapModel(row as unknown as Record<string, unknown>);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('AI provider model not found');
      }
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A model with this name already exists.');
      }
      throw err;
    }
  });

  // DELETE /api/ai-providers/models/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/ai-providers/models/:id',
    async (request, reply) => {
      try {
        await fastify.db.aiProviderModel.delete({
          where: { id: request.params.id },
        });
        providerConfigResolver.invalidate();
        reply.code(204);
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('AI provider model not found');
        }
        throw err;
      }
    },
  );
}
