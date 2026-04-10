import type { FastifyInstance } from 'fastify';
import { TaskType, AIProvider, AppScope, TASK_APP_SCOPE } from '@bronco/shared-types';
import { getTaskTypeDefaults } from '@bronco/ai-provider';
import type { AIRouter, ModelConfigResolver } from '@bronco/ai-provider';

const VALID_SCOPES = new Set(['APP_WIDE', 'CLIENT']);
const VALID_PROVIDERS = new Set<string>(Object.values(AIProvider));
const VALID_TASK_TYPES = new Set<string>(Object.values(TaskType));
const VALID_APP_SCOPES = new Set<string>(Object.values(AppScope));

/** Providers with a working client implementation in AIRouter. */
const ROUTABLE_PROVIDERS = new Set<string>([AIProvider.LOCAL, AIProvider.CLAUDE]);

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

interface AiConfigRouteOpts {
  modelConfigResolver: ModelConfigResolver;
  ai: AIRouter;
}

export async function aiConfigRoutes(
  fastify: FastifyInstance,
  opts: AiConfigRouteOpts,
): Promise<void> {
  const { modelConfigResolver, ai } = opts;

  // ─── Defaults (read-only, from code) ──────────────────────────────────

  /** Return the hardcoded defaults for all task types. */
  fastify.get('/api/ai-config/defaults', async () => {
    return getTaskTypeDefaults();
  });

  // ─── Per-App AI Settings ─────────────────────────────────────────────

  /** Return AI settings for a specific app scope — defaults, active overrides,
   *  and available providers filtered by the app's enabledApps. */
  fastify.get<{
    Params: { appScope: string };
  }>('/api/ai-config/app/:appScope', async (request) => {
    const { appScope } = request.params;
    if (!VALID_APP_SCOPES.has(appScope)) {
      return fastify.httpErrors.badRequest(`Unknown app scope "${appScope}". Valid: ${[...VALID_APP_SCOPES].join(', ')}.`);
    }

    // Task types belonging to this app
    const appTaskTypes = Object.entries(TASK_APP_SCOPE)
      .filter(([, scope]) => scope === appScope)
      .map(([taskType]) => taskType);

    // Defaults for these task types
    const allDefaults = getTaskTypeDefaults();
    const defaults = allDefaults.filter((d) => appTaskTypes.includes(d.taskType));

    // Active overrides for these task types
    const configs = await fastify.db.aiModelConfig.findMany({
      where: { taskType: { in: appTaskTypes }, isActive: true },
      orderBy: [{ taskType: 'asc' }, { scope: 'asc' }],
    });

    // Available models enabled for this app (empty enabledApps = all apps)
    const allProviders = await fastify.db.aiProvider.findMany({
      where: { isActive: true },
      include: { models: { where: { isActive: true } } },
    });
    const filtered = allProviders.flatMap((p) =>
      (p.models as Array<{ id: string; name: string; model: string; capabilityLevel: string; enabledApps: string[] }>)
        .filter((m) => m.enabledApps.length === 0 || m.enabledApps.includes(appScope))
        .map((m) => ({
          id: m.id,
          name: m.name,
          provider: p.provider,
          model: m.model,
          capabilityLevel: m.capabilityLevel,
          routable: ROUTABLE_PROVIDERS.has(p.provider),
        })),
    );

    return { appScope, taskTypes: appTaskTypes, defaults, configs, providers: filtered };
  });

  // ─── Resolved (preview what config would be used) ─────────────────────

  /** Preview the resolved provider + model for a task type, optionally for a client.
   *  Uses the same resolution logic as the runtime AIRouter to avoid preview drift. */
  fastify.get<{
    Querystring: { taskType: string; clientId?: string };
  }>('/api/ai-config/resolved', async (request) => {
    const { taskType, clientId } = request.query;
    if (!VALID_TASK_TYPES.has(taskType)) {
      return fastify.httpErrors.badRequest(`Unknown task type "${taskType}"`);
    }
    return ai.resolveForPreview(taskType, clientId);
  });

  // ─── CRUD ──────────────────────────────────────────────────────────────

  /** List all AI model configs, optionally filtered. */
  fastify.get<{
    Querystring: { taskType?: string; clientId?: string; scope?: string };
  }>('/api/ai-config', async (request) => {
    const { taskType, clientId, scope } = request.query;
    return fastify.db.aiModelConfig.findMany({
      where: {
        ...(taskType && { taskType }),
        ...(clientId && { clientId }),
        ...(scope && { scope: scope as never }),
      },
      include: { client: { select: { name: true, shortCode: true } } },
      orderBy: [{ taskType: 'asc' }, { scope: 'asc' }],
    });
  });

  /** Get a single config by ID. */
  fastify.get<{ Params: { id: string } }>(
    '/api/ai-config/:id',
    async (request) => {
      const config = await fastify.db.aiModelConfig.findUnique({
        where: { id: request.params.id },
        include: { client: { select: { name: true, shortCode: true } } },
      });
      if (!config) return fastify.httpErrors.notFound('AI model config not found');
      return config;
    },
  );

  /** Create a new AI model config. */
  fastify.post<{
    Body: {
      taskType: string;
      scope: string;
      clientId?: string;
      provider: string;
      model: string;
      maxTokens?: number | null;
    };
  }>('/api/ai-config', async (request, reply) => {
    const { taskType, scope, provider, model, maxTokens } = request.body;
    const trimmedClientId = request.body.clientId?.trim() || null;

    if (!VALID_TASK_TYPES.has(taskType)) {
      return fastify.httpErrors.badRequest(`Unknown task type "${taskType}"`);
    }
    if (!VALID_SCOPES.has(scope)) {
      return fastify.httpErrors.badRequest(`Invalid scope "${scope}". Must be APP_WIDE or CLIENT.`);
    }
    if (!VALID_PROVIDERS.has(provider)) {
      return fastify.httpErrors.badRequest(`Invalid provider "${provider}". Must be LOCAL or CLAUDE.`);
    }
    if (!model?.trim()) {
      return fastify.httpErrors.badRequest('model is required and cannot be empty.');
    }
    if (scope === 'CLIENT' && !trimmedClientId) {
      return fastify.httpErrors.badRequest('clientId is required when scope is CLIENT.');
    }
    if (scope === 'APP_WIDE' && trimmedClientId) {
      return fastify.httpErrors.badRequest('clientId must be null when scope is APP_WIDE.');
    }

    try {
      const config = await fastify.db.aiModelConfig.create({
        data: {
          taskType,
          scope: scope as never,
          clientId: trimmedClientId,
          provider,
          model: model.trim(),
          ...(maxTokens !== undefined && { maxTokens }),
        },
      });
      modelConfigResolver.invalidate();
      reply.code(201);
      return config;
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(
          'A config already exists for this task type + scope + client combination.',
        );
      }
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.badRequest('Invalid clientId — client does not exist.');
      }
      throw err;
    }
  });

  /** Update an AI model config. */
  fastify.patch<{
    Params: { id: string };
    Body: {
      provider?: string;
      model?: string;
      maxTokens?: number | null;
      isActive?: boolean;
    };
  }>('/api/ai-config/:id', async (request) => {
    const { provider, model, maxTokens, isActive } = request.body;

    if (provider && !VALID_PROVIDERS.has(provider)) {
      return fastify.httpErrors.badRequest(`Invalid provider "${provider}". Must be LOCAL or CLAUDE.`);
    }
    if (model !== undefined && !model.trim()) {
      return fastify.httpErrors.badRequest('model cannot be empty.');
    }

    try {
      const config = await fastify.db.aiModelConfig.update({
        where: { id: request.params.id },
        data: {
          ...(provider !== undefined && { provider }),
          ...(model !== undefined && { model: model.trim() }),
          ...(maxTokens !== undefined && { maxTokens }),
          ...(isActive !== undefined && { isActive }),
        },
      });
      modelConfigResolver.invalidate();
      return config;
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('AI model config not found');
      }
      throw err;
    }
  });

  /** Delete an AI model config. */
  fastify.delete<{ Params: { id: string } }>(
    '/api/ai-config/:id',
    async (request, reply) => {
      try {
        await fastify.db.aiModelConfig.delete({
          where: { id: request.params.id },
        });
        modelConfigResolver.invalidate();
        reply.code(204);
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('AI model config not found');
        }
        throw err;
      }
    },
  );
}
