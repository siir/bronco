import type { FastifyInstance } from 'fastify';
import { Prisma } from '@bronco/db';
import { ClientUserType, TicketStatus, Priority, TicketCategory, TicketSource } from '@bronco/shared-types';
import type { TicketCreatedJob, IngestionJob } from '@bronco/shared-types';
import type { PortalUser } from '../plugins/auth.js';
import type { Queue } from 'bullmq';
import type { Config } from '../config.js';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

function requirePortalUser(request: { portalUser?: PortalUser }): PortalUser {
  if (!request.portalUser) {
    const err = Object.assign(new Error('Portal authentication required'), { statusCode: 401 });
    throw err;
  }
  return request.portalUser;
}

interface PortalTicketOpts {
  config: Config;
  ticketCreatedQueue?: Queue<TicketCreatedJob>;
  ingestQueue?: Queue<IngestionJob>;
}

export async function portalTicketRoutes(fastify: FastifyInstance, opts: PortalTicketOpts): Promise<void> {
  /**
   * Check if a ticket is visible to the portal user.
   * ADMIN users can see all client tickets.
   * USER users can see tickets where:
   * - requester email matches their email
   * - they previously commented (actor matches email)
   * - ticket metadata has their portalCreatorId
   */
  async function canAccessTicket(ticketId: string, portalUser: PortalUser): Promise<boolean> {
    const ticket = await fastify.db.ticket.findUnique({
      where: { id: ticketId },
      select: {
        clientId: true,
        metadata: true,
        followers: { select: { person: { select: { email: true } } } },
      },
    });

    if (!ticket || ticket.clientId !== portalUser.clientId) return false;
    if (portalUser.userType === ClientUserType.ADMIN) return true;

    // Check if user is a follower (any type)
    if (ticket.followers.some((f) => f.person?.email === portalUser.email)) return true;

    // Check metadata portalCreatorId
    const meta = ticket.metadata as Record<string, unknown> | null;
    if (meta?.['portalCreatorId'] === portalUser.personId) return true;

    // Check if user has commented on this ticket
    const commentCount = await fastify.db.ticketEvent.count({
      where: { ticketId, actor: portalUser.email },
    });
    return commentCount > 0;
  }

  /**
   * GET /api/portal/tickets
   */
  fastify.get<{ Querystring: { status?: string; category?: string; limit?: string; offset?: string } }>(
    '/api/portal/tickets',
    async (request, reply) => {
      const portalUser = requirePortalUser(request);
      const { status, category, limit: rawLimit, offset: rawOffset } = request.query;
      const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 100);
      const offset = Math.max(Number(rawOffset) || 0, 0);

      // Validate status values
      if (status) {
        const validStatuses = Object.values(TicketStatus) as string[];
        const statusValues = status.split(',');
        const invalid = statusValues.find((s) => !validStatuses.includes(s));
        if (invalid) return reply.code(400).send({ error: `Invalid status: ${invalid}` });
      }

      // Validate category value
      if (category) {
        const validCategories = Object.values(TicketCategory) as string[];
        if (!validCategories.includes(category)) {
          return reply.code(400).send({ error: `Invalid category: ${category}` });
        }
      }

      // Base where clause: must be this client
      const where: Record<string, unknown> = { clientId: portalUser.clientId };

      if (status) {
        where['status'] = { in: status.split(',') };
      }
      if (category) {
        where['category'] = category;
      }

      // USER type: only see their own tickets
      if (portalUser.userType !== ClientUserType.ADMIN) {
        where['OR'] = [
          { followers: { some: { person: { email: portalUser.email } } } },
          { metadata: { path: ['portalCreatorId'], equals: portalUser.personId } },
          { events: { some: { actor: portalUser.email } } },
        ];
      }

      const [tickets, total] = await Promise.all([
        fastify.db.ticket.findMany({
          where,
          omit: { knowledgeDoc: true },
          include: {
            system: { select: { name: true } },
            _count: { select: { events: true, artifacts: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        fastify.db.ticket.count({ where }),
      ]);

      return { tickets, total, limit, offset };
    },
  );

  /**
   * GET /api/portal/tickets/stats
   */
  fastify.get('/api/portal/tickets/stats', async (request) => {
    const portalUser = requirePortalUser(request);

    const where: Record<string, unknown> = { clientId: portalUser.clientId };

    if (portalUser.userType !== ClientUserType.ADMIN) {
      where['OR'] = [
        { followers: { some: { person: { email: portalUser.email } } } },
        { metadata: { path: ['portalCreatorId'], equals: portalUser.personId } },
        { events: { some: { actor: portalUser.email } } },
      ];
    }

    const [statusGroups, priorityGroups, categoryGroups] = await Promise.all([
      fastify.db.ticket.groupBy({ by: ['status'], where, _count: { _all: true } }),
      fastify.db.ticket.groupBy({ by: ['priority'], where, _count: { _all: true } }),
      fastify.db.ticket.groupBy({ by: ['category'], where: { ...where, category: { not: null } }, _count: { _all: true } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of statusGroups) byStatus[g.status] = g._count._all;

    const byPriority: Record<string, number> = {};
    for (const g of priorityGroups) byPriority[g.priority] = g._count._all;

    const byCategory: Record<string, number> = {};
    for (const g of categoryGroups) if (g.category) byCategory[g.category] = g._count._all;

    const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

    return { total, byStatus, byPriority, byCategory };
  });

  /**
   * GET /api/portal/tickets/:id
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/portal/tickets/:id',
    async (request, reply) => {
      const portalUser = requirePortalUser(request);
      const { id } = request.params;

      const allowed = await canAccessTicket(id, portalUser);
      if (!allowed) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }

      const ticket = await fastify.db.ticket.findUnique({
        where: { id },
        include: {
          system: { select: { name: true } },
          followers: { include: { person: { select: { name: true, email: true } } }, orderBy: { createdAt: 'asc' } },
          events: { orderBy: { createdAt: 'asc' }, take: 200 },
          artifacts: { select: { id: true, filename: true, mimeType: true, sizeBytes: true, description: true, createdAt: true } },
        },
      });

      if (!ticket) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }

      return ticket;
    },
  );

  /**
   * POST /api/portal/tickets
   */
  fastify.post<{ Body: { subject: string; description?: string; priority?: string } }>(
    '/api/portal/tickets',
    async (request, reply) => {
      const portalUser = requirePortalUser(request);
      const { subject, description, priority } = request.body;

      if (!subject || subject.trim().length === 0) {
        return reply.code(400).send({ error: 'Subject is required' });
      }

      // Validate priority
      if (priority) {
        const validPriorities = Object.values(Priority) as string[];
        if (!validPriorities.includes(priority)) {
          return reply.code(400).send({ error: `Invalid priority: ${priority}` });
        }
      }

      // The portal user's Person is already the canonical identity — reuse it
      // directly instead of looking up / creating a per-client Person (the
      // client-scoped Person model was removed by #219 Wave 1).
      const person = { id: portalUser.personId };

      // --- Async mode: enqueue to ingestion pipeline ---
      if (opts.ingestQueue) {
        const job: IngestionJob = {
          source: TicketSource.MANUAL,
          clientId: portalUser.clientId,
          payload: {
            subject: subject.trim(),
            description: description?.trim() || undefined,
            priority,
            portalCreatorId: portalUser.personId,
            personId: person.id,
          },
        };

        await opts.ingestQueue.add('ticket-ingest', job, {
          jobId: `ingest-portal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 },
        });

        reply.code(202);
        return { queued: true, message: 'Ticket submitted successfully' };
      }

      // --- Fallback: direct creation if ingest queue not available ---
      let ticket: Awaited<ReturnType<typeof fastify.db.ticket.create>>;
      for (let attempt = 0; attempt <= 3; attempt++) {
        const lastPortalTicket = await fastify.db.ticket.findFirst({
          where: { clientId: portalUser.clientId, ticketNumber: { gt: 0 } },
          orderBy: { ticketNumber: 'desc' },
          select: { ticketNumber: true },
        });
        const portalTicketNumber = (lastPortalTicket?.ticketNumber ?? 0) + 1;

        try {
          ticket = await fastify.db.ticket.create({
            data: {
              clientId: portalUser.clientId,
              subject: subject.trim(),
              description: description?.trim() || null,
              priority: (priority as Priority) ?? 'MEDIUM',
              source: 'MANUAL',
              ticketNumber: portalTicketNumber,
              metadata: { portalCreatorId: portalUser.personId },
              followers: {
                create: { personId: person.id, followerType: 'REQUESTER' },
              },
            },
          });
          break;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
            continue;
          }
          throw err;
        }
      }
      ticket = ticket!;

      // Enqueue ticket-created event for route dispatch
      if (opts.ticketCreatedQueue) {
        await opts.ticketCreatedQueue.add('ticket-created', {
          ticketId: ticket.id,
          clientId: ticket.clientId,
          source: (ticket.source ?? TicketSource.MANUAL) as TicketCreatedJob['source'],
          category: ticket.category ?? null,
        }, {
          jobId: `ticket-created-${ticket.id}`,
          attempts: 4,
          backoff: { type: 'exponential', delay: 30_000 },
        });
      }

      return reply.code(201).send(ticket);
    },
  );

  /**
   * POST /api/portal/tickets/:id/comments
   */
  fastify.post<{ Params: { id: string }; Body: { content: string } }>(
    '/api/portal/tickets/:id/comments',
    async (request, reply) => {
      const portalUser = requirePortalUser(request);
      const { id } = request.params;
      const { content } = request.body;

      if (!content || content.trim().length === 0) {
        return reply.code(400).send({ error: 'Comment content is required' });
      }

      const allowed = await canAccessTicket(id, portalUser);
      if (!allowed) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }

      const event = await fastify.db.ticketEvent.create({
        data: {
          ticketId: id,
          eventType: 'COMMENT',
          content: content.trim(),
          actor: portalUser.email,
        },
      });

      return reply.code(201).send(event);
    },
  );

  /**
   * POST /api/portal/tickets/:id/attachments
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/portal/tickets/:id/attachments',
    async (request, reply) => {
      const portalUser = requirePortalUser(request);
      const { id } = request.params;

      const allowed = await canAccessTicket(id, portalUser);
      if (!allowed) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }

      const file = await request.file();
      if (!file) {
        return reply.code(400).send({ error: 'No file uploaded' });
      }

      const now = new Date();
      const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      // Sanitize filename to prevent path traversal
      const safeFilename = basename(file.filename).replace(/[\x00-\x1f\x7f]/g, '').replace(/[^\w .\-]/g, '_') || 'upload';
      const storagePath = `${yearMonth}/${Date.now()}-${safeFilename}`;
      const fullPath = join(opts.config.ARTIFACT_STORAGE_PATH, storagePath);

      await mkdir(dirname(fullPath), { recursive: true });

      // Stream file directly to disk to avoid buffering entire upload in memory
      await pipeline(file.file, createWriteStream(fullPath));

      const fileStat = await stat(fullPath);

      const artifact = await fastify.db.artifact.create({
        data: {
          ticketId: id,
          filename: safeFilename,
          mimeType: file.mimetype,
          sizeBytes: fileStat.size,
          storagePath,
          description: (request.query as Record<string, string>)['description'] ?? null,
        },
      });

      return reply.code(201).send(artifact);
    },
  );

  /**
   * GET /api/portal/tickets/:id/attachments/:aid/download
   */
  fastify.get<{ Params: { id: string; aid: string } }>(
    '/api/portal/tickets/:id/attachments/:aid/download',
    async (request, reply) => {
      const portalUser = requirePortalUser(request);
      const { id, aid } = request.params;

      const allowed = await canAccessTicket(id, portalUser);
      if (!allowed) {
        return reply.code(404).send({ error: 'Ticket not found' });
      }

      const artifact = await fastify.db.artifact.findUnique({ where: { id: aid } });
      if (!artifact || artifact.ticketId !== id) {
        return reply.code(404).send({ error: 'Artifact not found' });
      }

      const fullPath = join(opts.config.ARTIFACT_STORAGE_PATH, artifact.storagePath);
      try {
        await stat(fullPath);
      } catch {
        return reply.code(404).send({ error: 'File not found on disk' });
      }

      // Sanitize filename for Content-Disposition to prevent header injection
      const safeFilename = basename(artifact.filename).replace(/[\x00-\x1f\x7f"\\]/g, '_');
      reply.header('Content-Type', artifact.mimeType);
      reply.header('Content-Disposition', `attachment; filename="${safeFilename}"`);
      return reply.send(createReadStream(fullPath));
    },
  );
}
