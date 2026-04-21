import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@bronco/db';
import { ToolRequestStatus } from '@bronco/shared-types';

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

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function toolRequestRoutes(fastify: FastifyInstance): Promise<void> {
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

    return { ...row, linkedTickets };
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
}
