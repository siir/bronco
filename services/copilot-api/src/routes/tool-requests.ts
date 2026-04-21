import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@bronco/db';
import { ToolRequestStatus } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { ToolRequestNotFoundError, ToolRequestNotEligibleError } from '@bronco/shared-utils';
import { runToolRequestDedupe } from '../services/tool-request-dedupe.js';
import { createToolRequestGithubIssue } from '../services/tool-request-github.js';

const STATUS_VALUES = Object.values(ToolRequestStatus) as [string, ...string[]];

const listQuerySchema = z.object({
  status: z
    .union([z.enum(STATUS_VALUES), z.array(z.enum(STATUS_VALUES))])
    .optional(),
  clientId: z.string().uuid().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const updateBodySchema = z.object({
  status: z.enum(STATUS_VALUES).optional(),
  rejectedReason: z.string().optional(),
  duplicateOfId: z.string().uuid().nullable().optional(),
  implementedInCommit: z.string().optional(),
  implementedInIssue: z.string().optional(),
  githubIssueUrl: z.string().url().optional(),
});

const dedupeBodySchema = z.object({
  clientId: z.string().uuid(),
});

const suggestionBodySchema = z.object({
  kind: z.enum(['duplicate', 'improves_existing']),
});

const createGithubIssueBodySchema = z.object({
  repoOwner: z.string().min(1).optional(),
  repoName: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).optional(),
});

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export interface ToolRequestRouteOpts {
  ai: AIRouter;
  encryptionKey: string;
  mcpPlatformUrl?: string;
  mcpRepoUrl?: string;
  mcpDatabaseUrl?: string;
  platformApiKey?: string;
}

export async function toolRequestRoutes(
  fastify: FastifyInstance,
  opts: ToolRequestRouteOpts,
): Promise<void> {
  // List tool requests with filters
  fastify.get('/api/tool-requests', async (request) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(
        parsed.error.errors[0]?.message ?? 'Invalid query parameters',
      );
    }
    const { status, clientId, search, limit, offset } = parsed.data;

    const where: Prisma.ToolRequestWhereInput = {};
    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      where.status = { in: statuses as ToolRequestStatus[] };
    }
    if (clientId) where.clientId = clientId;
    if (search) {
      where.OR = [
        { requestedName: { contains: search, mode: 'insensitive' } },
        { displayTitle: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      fastify.db.toolRequest.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: {
          client: { select: { id: true, name: true, shortCode: true } },
          _count: { select: { rationales: true } },
        },
        take: limit ?? 50,
        skip: offset ?? 0,
      }),
      fastify.db.toolRequest.count({ where }),
    ]);

    return { items, total };
  });

  // Get single tool request with rationales, duplicates, and linked tickets
  fastify.get<{ Params: { id: string } }>('/api/tool-requests/:id', async (request) => {
    const row = await fastify.db.toolRequest.findUnique({
      where: { id: request.params.id },
      include: {
        client: { select: { id: true, name: true, shortCode: true } },
        rationales: {
          orderBy: { createdAt: 'desc' },
          include: {
            ticket: {
              select: { id: true, ticketNumber: true, subject: true, status: true },
            },
          },
        },
        duplicates: {
          select: {
            id: true,
            requestedName: true,
            displayTitle: true,
            status: true,
            requestCount: true,
          },
        },
        duplicateOf: {
          select: {
            id: true,
            requestedName: true,
            displayTitle: true,
            status: true,
          },
        },
        firstTicket: {
          select: { id: true, ticketNumber: true, subject: true, status: true },
        },
      },
    });
    if (!row) return fastify.httpErrors.notFound('Tool request not found');

    // Derive distinct linked tickets from rationale history
    const seen = new Set<string>();
    const linkedTickets: Array<{
      id: string;
      ticketNumber: number;
      subject: string;
      status: string;
    }> = [];
    for (const r of row.rationales) {
      if (r.ticket && !seen.has(r.ticket.id)) {
        seen.add(r.ticket.id);
        linkedTickets.push(r.ticket);
      }
    }

    // Resolve a short preview of the suggested canonical duplicate when present
    let suggestedDuplicateOf: {
      id: string;
      requestedName: string;
      displayTitle: string;
      status: string;
    } | null = null;
    if (row.suggestedDuplicateOfId) {
      const canonical = await fastify.db.toolRequest.findUnique({
        where: { id: row.suggestedDuplicateOfId },
        select: { id: true, requestedName: true, displayTitle: true, status: true },
      });
      suggestedDuplicateOf = canonical;
    }

    return { ...row, linkedTickets, suggestedDuplicateOf };
  });

  // Update tool request (status transitions, reasons, implementation refs)
  fastify.patch<{ Params: { id: string } }>('/api/tool-requests/:id', async (request) => {
    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(
        parsed.error.errors[0]?.message ?? 'Invalid request body',
      );
    }

    const existing = await fastify.db.toolRequest.findUnique({
      where: { id: request.params.id },
      select: { status: true },
    });
    if (!existing) return fastify.httpErrors.notFound('Tool request not found');

    const body = parsed.data;
    const data: Prisma.ToolRequestUpdateInput = {};

    if (body.status) {
      data.status = body.status as ToolRequestStatus;
      if (
        body.status === ToolRequestStatus.APPROVED &&
        existing.status === ToolRequestStatus.PROPOSED
      ) {
        data.approvedAt = new Date();
        data.approvedBy = request.user?.personId ?? null;
      }
      if (body.status === ToolRequestStatus.REJECTED && !body.rejectedReason) {
        return fastify.httpErrors.badRequest('rejectedReason is required when rejecting');
      }
      if (body.status === ToolRequestStatus.DUPLICATE && !body.duplicateOfId) {
        return fastify.httpErrors.badRequest('duplicateOfId is required when marking duplicate');
      }
    }
    if (body.rejectedReason !== undefined) data.rejectedReason = body.rejectedReason;
    if (body.duplicateOfId !== undefined) {
      data.duplicateOf =
        body.duplicateOfId === null
          ? { disconnect: true }
          : { connect: { id: body.duplicateOfId } };
    }
    if (body.implementedInCommit !== undefined) data.implementedInCommit = body.implementedInCommit;
    if (body.implementedInIssue !== undefined) data.implementedInIssue = body.implementedInIssue;
    if (body.githubIssueUrl !== undefined) data.githubIssueUrl = body.githubIssueUrl;

    try {
      return await fastify.db.toolRequest.update({
        where: { id: request.params.id },
        data,
        include: {
          client: { select: { id: true, name: true, shortCode: true } },
          _count: { select: { rationales: true } },
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Tool request not found');
      }
      throw err;
    }
  });

  // Delete tool request (cascades to rationales)
  fastify.delete<{ Params: { id: string } }>(
    '/api/tool-requests/:id',
    async (request, reply) => {
      try {
        await fastify.db.toolRequest.delete({ where: { id: request.params.id } });
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('Tool request not found');
        }
        throw err;
      }
      reply.code(204).send();
    },
  );

  // Run dedupe analysis for a client — populates suggestion fields on
  // PROPOSED/APPROVED rows. Idempotent; each run overwrites prior suggestions.
  fastify.post<{ Body: { clientId: string } }>(
    '/api/tool-requests/dedupe-analyses',
    async (request, reply) => {
      const parsed = dedupeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return fastify.httpErrors.badRequest(
          parsed.error.errors[0]?.message ?? 'clientId is required',
        );
      }
      const client = await fastify.db.client.findUnique({
        where: { id: parsed.data.clientId },
        select: { id: true },
      });
      if (!client) return fastify.httpErrors.notFound('Client not found');

      try {
        return await runToolRequestDedupe(
          fastify.db,
          opts.ai,
          parsed.data.clientId,
          opts.encryptionKey,
          {
            mcpPlatformUrl: opts.mcpPlatformUrl,
            mcpRepoUrl: opts.mcpRepoUrl,
            mcpDatabaseUrl: opts.mcpDatabaseUrl,
            platformApiKey: opts.platformApiKey,
          },
        );
      } catch (err) {
        reply.code(500);
        const error = err as Error & { debugContent?: string };
        return { error: error.message, debugContent: error.debugContent };
      }
    },
  );

  // Accept an AI-suggested transition (duplicate or improves-existing).
  fastify.post<{
    Params: { id: string };
    Body: { kind: 'duplicate' | 'improves_existing' };
  }>('/api/tool-requests/:id/accept-suggestion', async (request) => {
    const parsed = suggestionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(
        parsed.error.errors[0]?.message ?? 'kind must be "duplicate" or "improves_existing"',
      );
    }
    const { kind } = parsed.data;

    const row = await fastify.db.toolRequest.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        suggestedDuplicateOfId: true,
        suggestedImprovesExisting: true,
      },
    });
    if (!row) return fastify.httpErrors.notFound('Tool request not found');

    // Accepting one kind transitions the row to a terminal status, so any
    // *other* stale suggestion on the same row is no longer actionable — clear
    // both suggestion field sets and the dedupe timestamp to keep the row
    // consistent (Copilot #3118042310).
    const clearAllSuggestions = {
      suggestedDuplicateOfId: null,
      suggestedDuplicateReason: null,
      suggestedImprovesExisting: null,
      suggestedImprovesReason: null,
      dedupeAnalysisAt: null,
    } as const;

    if (kind === 'duplicate') {
      if (!row.suggestedDuplicateOfId) {
        return fastify.httpErrors.badRequest('No duplicate suggestion on this request');
      }
      return fastify.db.toolRequest.update({
        where: { id: row.id },
        data: {
          status: ToolRequestStatus.DUPLICATE,
          duplicateOf: { connect: { id: row.suggestedDuplicateOfId } },
          ...clearAllSuggestions,
        },
        include: {
          client: { select: { id: true, name: true, shortCode: true } },
          _count: { select: { rationales: true } },
        },
      });
    }

    // improves_existing
    if (!row.suggestedImprovesExisting) {
      return fastify.httpErrors.badRequest('No improves-existing suggestion on this request');
    }
    return fastify.db.toolRequest.update({
      where: { id: row.id },
      data: {
        status: ToolRequestStatus.REJECTED,
        rejectedReason: `Improves existing tool: ${row.suggestedImprovesExisting}`,
        ...clearAllSuggestions,
      },
      include: {
        client: { select: { id: true, name: true, shortCode: true } },
        _count: { select: { rationales: true } },
      },
    });
  });

  // Dismiss an AI-suggested transition — clears suggestion fields, no status change.
  fastify.post<{
    Params: { id: string };
    Body: { kind: 'duplicate' | 'improves_existing' };
  }>('/api/tool-requests/:id/dismiss-suggestion', async (request) => {
    const parsed = suggestionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(
        parsed.error.errors[0]?.message ?? 'kind must be "duplicate" or "improves_existing"',
      );
    }
    const { kind } = parsed.data;

    const data: Prisma.ToolRequestUpdateInput =
      kind === 'duplicate'
        ? { suggestedDuplicateOfId: null, suggestedDuplicateReason: null }
        : { suggestedImprovesExisting: null, suggestedImprovesReason: null };

    try {
      return await fastify.db.toolRequest.update({
        where: { id: request.params.id },
        data,
        include: {
          client: { select: { id: true, name: true, shortCode: true } },
          _count: { select: { rationales: true } },
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Tool request not found');
      }
      throw err;
    }
  });

  // Create a GitHub issue for this tool request. Uses the configured default
  // repo (SETTINGS_KEY_TOOL_REQUESTS_DEFAULT_REPO) unless overridden.
  fastify.post<{
    Params: { id: string };
    Body: { repoOwner?: string; repoName?: string; labels?: string[] };
  }>('/api/tool-requests/:id/create-github-issue', async (request, reply) => {
    const parsed = createGithubIssueBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(
        parsed.error.errors[0]?.message ?? 'Invalid request body',
      );
    }
    try {
      return await createToolRequestGithubIssue(fastify.db, opts.encryptionKey, {
        toolRequestId: request.params.id,
        repoOwner: parsed.data.repoOwner,
        repoName: parsed.data.repoName,
        labels: parsed.data.labels,
      });
    } catch (err) {
      // Map typed errors from the shared helper to proper HTTP statuses.
      // Not-found → 404 (row missing); not-eligible → 409 (wrong status or
      // existing issue); config missing → 400; GitHub API error → 502.
      if (err instanceof ToolRequestNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof ToolRequestNotEligibleError) {
        reply.code(409);
        return { error: err.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not configured') || msg.includes('missing')) {
        reply.code(400);
        return { error: msg };
      }
      if (msg.startsWith('GitHub API error')) {
        reply.code(502);
        return { error: msg };
      }
      reply.code(500);
      return { error: msg };
    }
  });
}
