import type { FastifyInstance } from 'fastify';
import { encrypt, decrypt } from '@bronco/shared-utils';
import { AIProvider } from '@bronco/shared-types';
import { resolveClientScope } from '../plugins/client-scope.js';

/** Providers that support external API keys and can be tested over the network. */
const BYOK_PROVIDERS = new Set<string>([AIProvider.CLAUDE, AIProvider.OPENAI, AIProvider.GROK]);

interface CredentialRouteOpts {
  encryptionKey: string;
}

export async function clientAiCredentialRoutes(
  fastify: FastifyInstance,
  opts: CredentialRouteOpts,
): Promise<void> {
  const { encryptionKey } = opts;

  /** Strip encrypted key, add last4 for safe display. */
  function redactCredential(row: { encryptedApiKey: string; [key: string]: unknown }) {
    const { encryptedApiKey, ...rest } = row;
    let last4 = '****';
    try {
      const plaintext = decrypt(encryptedApiKey, encryptionKey);
      last4 = plaintext.slice(-4);
    } catch { /* non-fatal */ }
    return { ...rest, last4 };
  }

  // GET /api/clients/:id/ai-credentials
  fastify.get<{ Params: { id: string } }>('/api/clients/:id/ai-credentials', async (request, reply) => {
    const scope = await resolveClientScope(request);
    if (
      scope.type === 'single' && scope.clientId !== request.params.id ||
      scope.type === 'assigned' && !scope.clientIds.includes(request.params.id)
    ) {
      return reply.code(403).send({ error: 'clientId not in your scope' });
    }
    const rows = await fastify.db.clientAiCredential.findMany({
      where: { clientId: request.params.id },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => redactCredential(r as unknown as { encryptedApiKey: string; [key: string]: unknown }));
  });

  // POST /api/clients/:id/ai-credentials
  fastify.post<{ Params: { id: string }; Body: { provider: string; apiKey: string; label: string } }>(
    '/api/clients/:id/ai-credentials',
    async (request, reply) => {
      const scope = await resolveClientScope(request);
      if (
        scope.type === 'single' && scope.clientId !== request.params.id ||
        scope.type === 'assigned' && !scope.clientIds.includes(request.params.id)
      ) {
        return reply.code(403).send({ error: 'clientId not in your scope' });
      }
      const { provider, apiKey, label } = request.body;
      if (!BYOK_PROVIDERS.has(provider)) {
        return reply.code(400).send({ error: `Invalid provider: ${provider}. Supported BYOK providers: ${[...BYOK_PROVIDERS].join(', ')}` });
      }
      const trimmedApiKey = apiKey?.trim();
      const trimmedLabel = label?.trim();
      if (!trimmedApiKey) return reply.code(400).send({ error: 'apiKey is required' });
      if (!trimmedLabel) return reply.code(400).send({ error: 'label is required' });

      const encryptedApiKey = encrypt(trimmedApiKey, encryptionKey);
      const row = await fastify.db.clientAiCredential.create({
        data: { clientId: request.params.id, provider, encryptedApiKey, label: trimmedLabel },
      });
      reply.code(201);
      return redactCredential(row as unknown as { encryptedApiKey: string; [key: string]: unknown });
    },
  );

  // PATCH /api/clients/:id/ai-credentials/:credId
  fastify.patch<{ Params: { id: string; credId: string }; Body: { label?: string; isActive?: boolean; apiKey?: string } }>(
    '/api/clients/:id/ai-credentials/:credId',
    async (request, reply) => {
      const scope = await resolveClientScope(request);
      if (
        scope.type === 'single' && scope.clientId !== request.params.id ||
        scope.type === 'assigned' && !scope.clientIds.includes(request.params.id)
      ) {
        return reply.code(403).send({ error: 'clientId not in your scope' });
      }
      const { label, isActive, apiKey } = request.body;
      const data: Record<string, unknown> = {};
      if (label !== undefined) {
        if (typeof label !== 'string' || !label.trim()) {
          return reply.code(400).send({ error: 'label must be a non-empty string' });
        }
        data.label = label.trim();
      }
      if (isActive !== undefined) {
        if (typeof isActive !== 'boolean') {
          return reply.code(400).send({ error: 'isActive must be a boolean' });
        }
        data.isActive = isActive;
      }
      if (apiKey !== undefined) {
        if (typeof apiKey !== 'string' || !apiKey.trim()) {
          return reply.code(400).send({ error: 'apiKey must be a non-empty string' });
        }
        data.encryptedApiKey = encrypt(apiKey.trim(), encryptionKey);
      }

      const existing = await fastify.db.clientAiCredential.findFirst({
        where: { id: request.params.credId, clientId: request.params.id },
      });
      if (!existing) return reply.code(404).send({ error: 'Credential not found' });

      const row = await fastify.db.clientAiCredential.update({
        where: { id: request.params.credId },
        data,
      });
      return redactCredential(row as unknown as { encryptedApiKey: string; [key: string]: unknown });
    },
  );

  // DELETE /api/clients/:id/ai-credentials/:credId
  fastify.delete<{ Params: { id: string; credId: string } }>(
    '/api/clients/:id/ai-credentials/:credId',
    async (request, reply) => {
      const scope = await resolveClientScope(request);
      if (
        scope.type === 'single' && scope.clientId !== request.params.id ||
        scope.type === 'assigned' && !scope.clientIds.includes(request.params.id)
      ) {
        return reply.code(403).send({ error: 'clientId not in your scope' });
      }
      const result = await fastify.db.clientAiCredential.deleteMany({
        where: { id: request.params.credId, clientId: request.params.id },
      });
      if (result.count === 0) return reply.code(404).send({ error: 'Credential not found' });
      return reply.code(204).send();
    },
  );

  // POST /api/clients/:id/ai-credentials/:credId/test
  fastify.post<{ Params: { id: string; credId: string } }>(
    '/api/clients/:id/ai-credentials/:credId/test',
    async (request, reply) => {
      const scope = await resolveClientScope(request);
      if (
        scope.type === 'single' && scope.clientId !== request.params.id ||
        scope.type === 'assigned' && !scope.clientIds.includes(request.params.id)
      ) {
        return reply.code(403).send({ error: 'clientId not in your scope' });
      }
      const cred = await fastify.db.clientAiCredential.findFirst({
        where: { id: request.params.credId, clientId: request.params.id },
      });
      if (!cred) return reply.code(404).send({ error: 'Credential not found' });

      let apiKey: string;
      try {
        apiKey = decrypt(cred.encryptedApiKey, encryptionKey);
      } catch {
        return reply.code(500).send({ error: 'Failed to decrypt credential' });
      }

      if (cred.provider === 'CLAUDE') {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          const testRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: controller.signal,
          });
          if (testRes.ok) return { ok: true, provider: cred.provider };
          return reply.code(400).send({ ok: false, error: `Provider returned ${testRes.status}` });
        } catch (err: unknown) {
          if ((err as { name?: string })?.name === 'AbortError') {
            return reply.code(504).send({ ok: false, error: 'Credential test timed out contacting provider' });
          }
          return reply.code(502).send({ ok: false, error: 'Failed to connect to provider' });
        } finally {
          clearTimeout(timeoutId);
        }
      }

      if (cred.provider === 'OPENAI' || cred.provider === 'GROK') {
        const baseUrl = cred.provider === 'GROK' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1';
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
          const testRes = await fetch(`${baseUrl}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          if (testRes.ok) return { ok: true, provider: cred.provider };
          return reply.code(400).send({ ok: false, error: `Provider returned ${testRes.status}` });
        } catch (err: unknown) {
          if ((err as { name?: string })?.name === 'AbortError') {
            return reply.code(504).send({ ok: false, error: 'Credential test timed out contacting provider' });
          }
          return reply.code(502).send({ ok: false, error: 'Failed to connect to provider' });
        } finally {
          clearTimeout(timeoutId);
        }
      }

      return reply.code(400).send({ ok: false, error: `Provider "${cred.provider}" does not support network testing` });
    },
  );
}
