import type { FastifyInstance } from 'fastify';
import { EntityType, LogLevel } from '@bronco/shared-types';

const VALID_LEVELS = new Set<string>(Object.values(LogLevel));
const VALID_ENTITY_TYPES = new Set<string>(Object.values(EntityType));

export async function logRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: {
      service?: string;
      level?: string;
      entityId?: string;
      entityType?: string;
      search?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
      cursor?: string;
      direction?: string;
    };
  }>('/api/logs', async (request) => {
    const {
      service,
      level,
      entityId,
      entityType,
      search,
      since,
      until,
      limit: rawLimit = '100',
      offset: rawOffset = '0',
      cursor,
      direction = 'older',
    } = request.query;

    const takeNum = Number(rawLimit);
    const skipNum = Number(rawOffset);
    if (!Number.isFinite(takeNum) || !Number.isInteger(takeNum) || takeNum < 0 ||
        !Number.isFinite(skipNum) || !Number.isInteger(skipNum) || skipNum < 0) {
      return fastify.httpErrors.badRequest('limit and offset must be non-negative integers');
    }
    if (direction !== 'older' && direction !== 'newer') {
      return fastify.httpErrors.badRequest('direction must be "older" or "newer"');
    }
    const take = takeNum;
    const skip = skipNum;

    const where: Record<string, unknown> = {};

    if (service) where.service = service;
    if (level) {
      if (!VALID_LEVELS.has(level)) {
        return fastify.httpErrors.badRequest(
          `Invalid level "${level}". Must be one of: ${[...VALID_LEVELS].join(', ')}.`,
        );
      }
      where.level = level;
    }
    if (entityId) where.entityId = entityId;
    if (entityType) {
      if (!VALID_ENTITY_TYPES.has(entityType)) {
        return fastify.httpErrors.badRequest(
          `Invalid entityType "${entityType}". Must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}.`,
        );
      }
      where.entityType = entityType;
    }

    if (search) {
      where.message = { contains: search, mode: 'insensitive' };
    }

    if (since || until) {
      const createdAt: Record<string, Date> = {};
      if (since) {
        const sinceDate = new Date(since);
        if (Number.isNaN(sinceDate.getTime())) {
          return fastify.httpErrors.badRequest('since must be a valid date');
        }
        createdAt.gte = sinceDate;
      }
      if (until) {
        const untilDate = new Date(until);
        if (Number.isNaN(untilDate.getTime())) {
          return fastify.httpErrors.badRequest('until must be a valid date');
        }
        createdAt.lte = untilDate;
      }
      where.createdAt = createdAt;
    }

    // Cursor-based pagination
    if (cursor) {
      const cursorRow = await fastify.db.appLog.findUnique({ where: { id: cursor }, select: { id: true, createdAt: true } });
      if (!cursorRow) {
        return fastify.httpErrors.badRequest(`cursor "${cursor}" not found`);
      }

      const op = direction === 'older' ? 'lt' : 'gt';
      const cursorWhere = {
        ...where,
        OR: [
          { createdAt: { [op]: cursorRow.createdAt } },
          { createdAt: cursorRow.createdAt, id: { [op]: cursorRow.id } },
        ],
      };

      const capped = Math.min(take, 500);
      const orderDir = direction === 'older' ? 'desc' : 'asc';
      const rows = await fastify.db.appLog.findMany({
        where: cursorWhere,
        orderBy: [{ createdAt: orderDir }, { id: orderDir }],
        take: capped + 1,
      });

      const hasMore = rows.length > capped;
      const logs = hasMore ? rows.slice(0, capped) : rows;
      const nextCursor = logs.length > 0 ? logs[logs.length - 1].id : null;

      return { logs, nextCursor, hasMore };
    }

    // Offset-based pagination (original behavior)
    const [logs, total] = await Promise.all([
      fastify.db.appLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(take, 500),
        skip,
      }),
      fastify.db.appLog.count({ where }),
    ]);

    return { logs, total };
  });

  fastify.get('/api/logs/services', async () => {
    const result = await fastify.db.appLog.findMany({
      select: { service: true },
      distinct: ['service'],
      orderBy: { service: 'asc' },
    });
    return result.map((r) => r.service);
  });
}
