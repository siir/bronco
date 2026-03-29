import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ExternalServiceCheckType } from '@bronco/shared-types';
import { isBlockedHostname, resolveAndValidateHostname } from '../services/ssrf.js';

/**
 * Synchronous endpoint validation (Zod superRefine).
 * Checks URL format, protocol, and blocked hostname/IP ranges.
 * DNS-based validation happens asynchronously in the route handler via
 * `validateEndpointDns()` after Zod parsing succeeds.
 */
function validateEndpoint(
  endpoint: string | undefined,
  checkType: string | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!endpoint || !checkType) return;

  if (checkType === 'HTTP' || checkType === 'OLLAMA') {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoint'],
          message: 'Endpoint must be an HTTP or HTTPS URL for HTTP/OLLAMA checks',
        });
        return;
      }
      // Block loopback, link-local, private, cloud metadata, and IPv6 private ranges
      if (isBlockedHostname(url.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endpoint'],
          message: 'Endpoint must not target loopback, link-local, or private IP ranges',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'Endpoint must be a valid URL for HTTP/OLLAMA checks',
      });
    }
  } else if (checkType === 'DOCKER') {
    const dockerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
    if (!dockerNamePattern.test(endpoint)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'Endpoint must be a valid Docker container name for DOCKER checks',
      });
    }
  }
}

/**
 * Async DNS resolution check for HTTP/OLLAMA endpoints used at create/update time.
 * Resolves the hostname to IP addresses and validates them against blocked ranges.
 * This helper alone does NOT prevent DNS rebinding; callers MUST re-resolve and
 * validate the hostname/IP immediately before each outbound request (or pin/verify
 * the resolved IP) to properly mitigate DNS rebinding / CNAME chain attacks.
 * Returns an error message string if blocked, or null if safe.
 */
async function validateEndpointDns(
  endpoint: string,
  checkType: string,
): Promise<string | null> {
  if (checkType !== 'HTTP' && checkType !== 'OLLAMA') return null;

  try {
    const url = new URL(endpoint);
    const result = await resolveAndValidateHostname(url.hostname);
    if (result.blocked) {
      return `Endpoint blocked: ${result.reason}`;
    }
  } catch {
    // URL parse errors are already caught by Zod validation
  }
  return null;
}

const createSchema = z
  .object({
    name: z.string().min(1).max(100),
    endpoint: z.string().min(1),
    checkType: z.nativeEnum(ExternalServiceCheckType).default(ExternalServiceCheckType.HTTP),
    isMonitored: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(30000).default(5000),
    notes: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => validateEndpoint(data.endpoint, data.checkType, ctx));

const updateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    endpoint: z.string().min(1).optional(),
    checkType: z.nativeEnum(ExternalServiceCheckType).optional(),
    isMonitored: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
    notes: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const hasEndpoint = typeof data.endpoint === 'string';
    const hasCheckType = typeof data.checkType === 'string';

    // If exactly one of endpoint or checkType is provided on update, require both.
    if (hasEndpoint !== hasCheckType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasEndpoint ? ['checkType'] : ['endpoint'],
        message: 'endpoint and checkType must be updated together',
      });
      return;
    }

    // If both are provided, validate the endpoint against the check type.
    if (hasEndpoint && hasCheckType) {
      validateEndpoint(data.endpoint, data.checkType, ctx);
    }
  });

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function externalServiceRoutes(fastify: FastifyInstance): Promise<void> {
  // Async DNS validation helper for PATCH (needs to know current checkType from DB)
  async function validatePatchDns(
    endpoint: string | undefined,
    checkType: string | undefined,
    existingCheckType: string | undefined,
  ): Promise<string | null> {
    const effectiveEndpoint = endpoint;
    const effectiveCheckType = checkType ?? existingCheckType;
    if (!effectiveEndpoint || !effectiveCheckType) return null;
    return validateEndpointDns(effectiveEndpoint, effectiveCheckType);
  }
  // GET /api/external-services — list all (optionally filter by ?isMonitored=true|false)
  fastify.get<{ Querystring: { isMonitored?: string } }>('/api/external-services', async (request) => {
    const where: { isMonitored?: boolean } = {};
    if (request.query.isMonitored === 'true') where.isMonitored = true;
    else if (request.query.isMonitored === 'false') where.isMonitored = false;

    return fastify.db.externalService.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
  });

  // GET /api/external-services/:id
  fastify.get<{ Params: { id: string } }>('/api/external-services/:id', async (request) => {
    const service = await fastify.db.externalService.findUnique({
      where: { id: request.params.id },
    });
    if (!service) return fastify.httpErrors.notFound('External service not found');
    return service;
  });

  // POST /api/external-services — create
  fastify.post<{ Body: z.input<typeof createSchema> }>(
    '/api/external-services',
    async (request, reply) => {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return fastify.httpErrors.badRequest(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      // Async DNS resolution check (reduces SSRF risk by blocking hostnames resolving to private IPs at validation time)
      if (parsed.data.endpoint && parsed.data.checkType) {
        const dnsError = await validateEndpointDns(parsed.data.endpoint, parsed.data.checkType);
        if (dnsError) {
          return fastify.httpErrors.badRequest(dnsError);
        }
      }
      try {
        const service = await fastify.db.externalService.create({
          data: parsed.data,
        });
        reply.code(201);
        return service;
      } catch (err) {
        if (isPrismaError(err, 'P2002')) {
          return fastify.httpErrors.conflict('An external service with this name already exists');
        }
        throw err;
      }
    },
  );

  // PATCH /api/external-services/:id — update
  fastify.patch<{ Params: { id: string }; Body: z.input<typeof updateSchema> }>(
    '/api/external-services/:id',
    async (request) => {
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return fastify.httpErrors.badRequest(
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      // Async DNS resolution check for endpoint updates
      if (parsed.data.endpoint) {
        // If checkType isn't provided in the update, we need the existing one from DB
        let effectiveCheckType = parsed.data.checkType;
        if (!effectiveCheckType) {
          const existing = await fastify.db.externalService.findUnique({
            where: { id: request.params.id },
            select: { checkType: true },
          });
          effectiveCheckType = existing?.checkType;
        }
        const dnsError = await validatePatchDns(parsed.data.endpoint, parsed.data.checkType, effectiveCheckType);
        if (dnsError) {
          return fastify.httpErrors.badRequest(dnsError);
        }
      }
      try {
        return await fastify.db.externalService.update({
          where: { id: request.params.id },
          data: parsed.data,
        });
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('External service not found');
        }
        if (isPrismaError(err, 'P2002')) {
          return fastify.httpErrors.conflict('An external service with this name already exists');
        }
        throw err;
      }
    },
  );

  // DELETE /api/external-services/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/external-services/:id',
    async (request, reply) => {
      try {
        await fastify.db.externalService.delete({
          where: { id: request.params.id },
        });
        reply.code(204);
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('External service not found');
        }
        throw err;
      }
    },
  );
}
