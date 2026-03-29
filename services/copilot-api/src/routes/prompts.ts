import type { FastifyInstance } from 'fastify';
import { ALL_PROMPTS, getPromptByKey, composePrompt } from '@bronco/ai-provider';
import type { PromptOverrideRow } from '@bronco/ai-provider';

const VALID_SCOPES = new Set(['APP_WIDE', 'CLIENT']);
const VALID_POSITIONS = new Set(['PREPEND', 'APPEND']);

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function promptRoutes(fastify: FastifyInstance): Promise<void> {
  // ─── Base Prompts (read-only, from code) ────────────────────────────────

  /** List all hardcoded base prompts with their override counts. */
  fastify.get<{
    Querystring: { taskType?: string; role?: string; search?: string };
  }>('/api/prompts', async (request) => {
    const { taskType, role, search } = request.query;

    let prompts = ALL_PROMPTS;
    if (taskType) prompts = prompts.filter((p) => p.taskType === taskType);
    if (role) prompts = prompts.filter((p) => p.role === role);
    if (typeof search === 'string' && search.trim()) {
      const term = search.trim().toLowerCase();
      prompts = prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          p.key.toLowerCase().includes(term) ||
          p.description.toLowerCase().includes(term) ||
          p.content.toLowerCase().includes(term),
      );
    }

    // Count overrides per prompt key
    const overrideCounts = await fastify.db.promptOverride.groupBy({
      by: ['promptKey'],
      where: { isActive: true },
      _count: true,
    });
    const countMap = new Map(overrideCounts.map((o) => [o.promptKey, o._count]));

    return prompts.map((p) => ({
      ...p,
      overrideCount: countMap.get(p.key) ?? 0,
    }));
  });

  /** Get a single base prompt by key, with its composed preview. */
  fastify.get<{
    Params: { key: string };
    Querystring: { clientId?: string };
  }>('/api/prompts/:key', async (request) => {
    const base = getPromptByKey(request.params.key);
    if (!base) return fastify.httpErrors.notFound('Prompt not found');

    const overrides = await fastify.db.promptOverride.findMany({
      where: { promptKey: base.key, isActive: true },
      include: { client: { select: { name: true, shortCode: true } } },
      orderBy: [{ scope: 'asc' }, { position: 'asc' }],
    });

    const overrideRows: PromptOverrideRow[] = overrides.map((o) => ({
      promptKey: o.promptKey,
      scope: o.scope as 'APP_WIDE' | 'CLIENT',
      clientId: o.clientId,
      position: o.position as 'PREPEND' | 'APPEND',
      content: o.content,
      isActive: o.isActive,
    }));

    const composed = composePrompt(base, overrideRows, request.query.clientId);

    return {
      base,
      overrides,
      composed,
    };
  });

  // ─── Overrides (full CRUD) ──────────────────────────────────────────────

  /** List all overrides, optionally filtered. */
  fastify.get<{
    Querystring: { promptKey?: string; clientId?: string; scope?: string };
  }>('/api/prompt-overrides', async (request) => {
    const { promptKey, clientId, scope } = request.query;
    return fastify.db.promptOverride.findMany({
      where: {
        ...(promptKey && { promptKey }),
        ...(clientId && { clientId }),
        ...(scope && { scope: scope as never }),
      },
      include: { client: { select: { name: true, shortCode: true } } },
      orderBy: [{ promptKey: 'asc' }, { scope: 'asc' }, { position: 'asc' }],
    });
  });

  /** Get a single override. */
  fastify.get<{ Params: { id: string } }>(
    '/api/prompt-overrides/:id',
    async (request) => {
      const override = await fastify.db.promptOverride.findUnique({
        where: { id: request.params.id },
        include: { client: { select: { name: true, shortCode: true } } },
      });
      if (!override) return fastify.httpErrors.notFound('Override not found');
      return override;
    },
  );

  /** Create an override. */
  fastify.post<{
    Body: {
      promptKey: string;
      scope: string;
      clientId?: string;
      position?: string;
      content: string;
    };
  }>('/api/prompt-overrides', async (request, reply) => {
    const { promptKey, scope, clientId, position, content } = request.body;

    // Validate the prompt key exists
    if (!getPromptByKey(promptKey)) {
      return fastify.httpErrors.badRequest(`Unknown prompt key "${promptKey}"`);
    }
    if (!VALID_SCOPES.has(scope)) {
      return fastify.httpErrors.badRequest(`Invalid scope "${scope}". Must be APP_WIDE or CLIENT.`);
    }
    if (position && !VALID_POSITIONS.has(position)) {
      return fastify.httpErrors.badRequest(`Invalid position "${position}". Must be PREPEND or APPEND.`);
    }
    if (!content?.trim()) {
      return fastify.httpErrors.badRequest('content is required and cannot be empty.');
    }
    if (scope === 'CLIENT' && !clientId) {
      return fastify.httpErrors.badRequest('clientId is required when scope is CLIENT.');
    }

    try {
      const override = await fastify.db.promptOverride.create({
        data: {
          promptKey,
          scope: scope as never,
          clientId: clientId ?? null,
          position: (position ?? 'APPEND') as never,
          content,
        },
      });
      reply.code(201);
      return override;
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict(
          'An override already exists for this prompt + scope + client combination.',
        );
      }
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.badRequest('Invalid clientId — client does not exist.');
      }
      throw err;
    }
  });

  /** Update an override. */
  fastify.patch<{
    Params: { id: string };
    Body: {
      position?: string;
      content?: string;
      isActive?: boolean;
    };
  }>('/api/prompt-overrides/:id', async (request) => {
    const { position, ...rest } = request.body;
    if (position && !VALID_POSITIONS.has(position)) {
      return fastify.httpErrors.badRequest(`Invalid position "${position}". Must be PREPEND or APPEND.`);
    }

    try {
      return await fastify.db.promptOverride.update({
        where: { id: request.params.id },
        data: {
          ...rest,
          ...(position !== undefined && { position: position as never }),
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Override not found');
      }
      throw err;
    }
  });

  /** Delete an override. */
  fastify.delete<{ Params: { id: string } }>(
    '/api/prompt-overrides/:id',
    async (request, reply) => {
      try {
        await fastify.db.promptOverride.delete({
          where: { id: request.params.id },
        });
        reply.code(204);
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('Override not found');
        }
        throw err;
      }
    },
  );

  // ─── Preview ────────────────────────────────────────────────────────────

  /** Preview a composed prompt with sample keyword values. */
  fastify.post<{
    Body: { promptKey: string; clientId?: string; values?: Record<string, string> };
  }>('/api/prompts/preview', async (request) => {
    const { promptKey, clientId, values } = request.body;

    const base = getPromptByKey(promptKey);
    if (!base) return fastify.httpErrors.notFound(`Unknown prompt key "${promptKey}"`);

    const overrides = await fastify.db.promptOverride.findMany({
      where: { promptKey, isActive: true },
    });

    const overrideRows: PromptOverrideRow[] = overrides.map((o) => ({
      promptKey: o.promptKey,
      scope: o.scope as 'APP_WIDE' | 'CLIENT',
      clientId: o.clientId,
      position: o.position as 'PREPEND' | 'APPEND',
      content: o.content,
      isActive: o.isActive,
    }));

    let composed = composePrompt(base, overrideRows, clientId);

    // Gather placeholders and resolve with sample values from keywords
    const placeholders = [...composed.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const keywords = placeholders.length > 0
      ? await fastify.db.promptKeyword.findMany({
          where: { token: { in: placeholders } },
        })
      : [];

    const sampleMap: Record<string, string> = {};
    for (const kw of keywords) {
      sampleMap[kw.token] = kw.sampleValue ?? `[${kw.label}]`;
    }
    const merged = { ...sampleMap, ...values };

    composed = composed.replace(/\{\{(\w+)\}\}/g, (match, token: string) => {
      return merged[token] ?? match;
    });

    return {
      rendered: composed,
      placeholders: placeholders.map((token) => {
        const kw = keywords.find((k) => k.token === token);
        return {
          token,
          resolved: merged[token] ?? null,
          label: kw?.label ?? null,
          description: kw?.description ?? null,
        };
      }),
    };
  });
}
