import type { FastifyInstance } from 'fastify';
import { EntityType, LogLevel } from '@bronco/shared-types';

const VALID_LEVELS = new Set<string>(Object.values(LogLevel));
const VALID_ENTITY_TYPES = new Set<string>(Object.values(EntityType));

interface CursorPayload { id: string; createdAt: string; }

function encodeCursor(id: string, createdAt: Date): string {
  return Buffer.from(JSON.stringify({ id, createdAt: createdAt.toISOString() })).toString('base64url');
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof decoded.id !== 'string' || typeof decoded.createdAt !== 'string') return null;
    return decoded as CursorPayload;
  } catch {
    return null;
  }
}

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
      direction,
    } = request.query;

    // limit is validated for both modes; offset only matters without a cursor
    const takeNum = Number(rawLimit);
    if (!Number.isFinite(takeNum) || !Number.isInteger(takeNum) || takeNum < 0) {
      return fastify.httpErrors.badRequest('limit must be a non-negative integer');
    }

    let skip = 0;
    if (!cursor) {
      const skipNum = Number(rawOffset);
      if (!Number.isFinite(skipNum) || !Number.isInteger(skipNum) || skipNum < 0) {
        return fastify.httpErrors.badRequest('offset must be a non-negative integer');
      }
      skip = skipNum;
    }

    const take = takeNum;

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
      // direction is only meaningful (and validated) in cursor mode
      const dir = direction ?? 'older';
      if (dir !== 'older' && dir !== 'newer') {
        return fastify.httpErrors.badRequest('direction must be "older" or "newer"');
      }

      // Decode the opaque cursor token ({id, createdAt} encoded as base64url JSON).
      // This avoids a DB round-trip: createdAt is already embedded in the token.
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return fastify.httpErrors.badRequest(`cursor "${cursor}" is invalid`);
      }
      const cursorCreatedAt = new Date(decoded.createdAt);
      if (Number.isNaN(cursorCreatedAt.getTime())) {
        return fastify.httpErrors.badRequest(`cursor "${cursor}" is invalid`);
      }

      const op = dir === 'older' ? 'lt' : 'gt';
      const cursorWhere = {
        ...where,
        OR: [
          { createdAt: { [op]: cursorCreatedAt } },
          { createdAt: cursorCreatedAt, id: { [op]: decoded.id } },
        ],
      };

      const capped = Math.min(take, 500);
      const orderDir = dir === 'older' ? 'desc' : 'asc';
      const rows = await fastify.db.appLog.findMany({
        where: cursorWhere,
        orderBy: [{ createdAt: orderDir }, { id: orderDir }],
        take: capped + 1,
      });

      const hasMore = rows.length > capped;
      const logs = hasMore ? rows.slice(0, capped) : rows;
      const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
      const nextCursor = lastLog ? encodeCursor(lastLog.id, lastLog.createdAt) : null;

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
