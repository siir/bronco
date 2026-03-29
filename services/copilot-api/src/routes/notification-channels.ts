import type { FastifyInstance } from 'fastify';
import { NotificationChannelType } from '@bronco/shared-types';
import { encrypt, decrypt, looksEncrypted } from '@bronco/shared-utils';
import { z } from 'zod';

const VALID_TYPES = new Set<string>(Object.values(NotificationChannelType));

/** Fields that contain secrets, keyed by channel type. */
const SECRET_FIELDS: Record<string, string[]> = {
  EMAIL: ['password'],
  PUSHOVER: ['appToken', 'userKey'],
};

const emailConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  user: z.string().min(1),
  password: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

const pushoverConfigSchema = z.object({
  appToken: z.string().min(1),
  userKey: z.string().min(1),
});

const CONFIG_SCHEMAS: Record<string, z.ZodSchema> = {
  EMAIL: emailConfigSchema,
  PUSHOVER: pushoverConfigSchema,
};

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

function encryptSecrets(
  type: string,
  config: Record<string, unknown>,
  encryptionKey: string,
): Record<string, unknown> {
  const fields = SECRET_FIELDS[type] ?? [];
  const result = { ...config };
  for (const field of fields) {
    const value = result[field];
    if (typeof value === 'string' && value.length > 0 && !looksEncrypted(value)) {
      result[field] = encrypt(value, encryptionKey);
    }
  }
  return result;
}

function redactSecrets(
  type: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const fields = SECRET_FIELDS[type] ?? [];
  const result = { ...config };
  for (const field of fields) {
    if (typeof result[field] === 'string') {
      result[field] = '••••••••';
    }
  }
  return result;
}

function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const type = row.type as string;
  const config = row.config as Record<string, unknown>;
  return { ...row, config: redactSecrets(type, config) };
}

interface NotificationChannelRouteOpts {
  encryptionKey: string;
}

export async function notificationChannelRoutes(
  fastify: FastifyInstance,
  opts: NotificationChannelRouteOpts,
): Promise<void> {
  const { encryptionKey } = opts;

  // GET /api/notification-channels
  fastify.get('/api/notification-channels', async () => {
    const rows = await fastify.db.notificationChannel.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => redactRow(r as unknown as Record<string, unknown>));
  });

  // GET /api/notification-channels/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/notification-channels/:id',
    async (request) => {
      const row = await fastify.db.notificationChannel.findUnique({
        where: { id: request.params.id },
      });
      if (!row) return fastify.httpErrors.notFound('Notification channel not found');
      return redactRow(row as unknown as Record<string, unknown>);
    },
  );

  // POST /api/notification-channels
  fastify.post<{
    Body: {
      name: string;
      type: string;
      config: Record<string, unknown>;
      isActive?: boolean;
    };
  }>('/api/notification-channels', async (request, reply) => {
    const { name, type, config, isActive } = request.body;

    if (!name?.trim()) return fastify.httpErrors.badRequest('name is required');
    if (!VALID_TYPES.has(type)) {
      return fastify.httpErrors.badRequest(
        `Invalid type "${type}". Must be one of: ${[...VALID_TYPES].join(', ')}`,
      );
    }

    const schema = CONFIG_SCHEMAS[type];
    if (schema) {
      const result = schema.safeParse(config);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return fastify.httpErrors.badRequest(`Invalid config for ${type}: ${issues}`);
      }
    }

    const encryptedConfig = encryptSecrets(type, config, encryptionKey);

    try {
      const row = await fastify.db.notificationChannel.create({
        data: {
          name: name.trim(),
          type: type as NotificationChannelType,
          config: encryptedConfig as object,
          isActive: isActive ?? true,
        },
      });
      reply.code(201);
      return redactRow(row as unknown as Record<string, unknown>);
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A notification channel with this name already exists.');
      }
      throw err;
    }
  });

  // PATCH /api/notification-channels/:id
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      config?: Record<string, unknown>;
      isActive?: boolean;
    };
  }>('/api/notification-channels/:id', async (request) => {
    const { name, config, isActive } = request.body;
    const existing = await fastify.db.notificationChannel.findUnique({
      where: { id: request.params.id },
    });
    if (!existing) return fastify.httpErrors.notFound('Notification channel not found');

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (isActive !== undefined) data.isActive = isActive;

    if (config !== undefined) {
      // Merge with existing config so partial updates work — replace redacted
      // sentinel values with existing encrypted values.
      const existingConfig = existing.config as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...existingConfig, ...config };
      const secretFields = SECRET_FIELDS[existing.type] ?? [];
      for (const field of secretFields) {
        if (merged[field] === '••••••••') {
          merged[field] = existingConfig[field];
        }
      }

      const schema = CONFIG_SCHEMAS[existing.type];
      if (schema) {
        const result = schema.safeParse(merged);
        if (!result.success) {
          const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
          return fastify.httpErrors.badRequest(`Invalid config for ${existing.type}: ${issues}`);
        }
      }

      data.config = encryptSecrets(existing.type, merged, encryptionKey);
    }

    try {
      const row = await fastify.db.notificationChannel.update({
        where: { id: request.params.id },
        data,
      });
      return redactRow(row as unknown as Record<string, unknown>);
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return fastify.httpErrors.conflict('A notification channel with this name already exists.');
      }
      throw err;
    }
  });

  // DELETE /api/notification-channels/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/notification-channels/:id',
    async (request, reply) => {
      try {
        await fastify.db.notificationChannel.delete({
          where: { id: request.params.id },
        });
        reply.code(204);
      } catch (err) {
        if (isPrismaError(err, 'P2025')) {
          return fastify.httpErrors.notFound('Notification channel not found');
        }
        throw err;
      }
    },
  );

  // POST /api/notification-channels/:id/test — send a test notification
  fastify.post<{ Params: { id: string } }>(
    '/api/notification-channels/:id/test',
    async (request) => {
      const row = await fastify.db.notificationChannel.findUnique({
        where: { id: request.params.id },
      });
      if (!row) return fastify.httpErrors.notFound('Notification channel not found');

      const config = row.config as Record<string, unknown>;

      if (row.type === 'EMAIL') {
        // Basic SMTP connectivity check via TCP EHLO handshake
        try {
          const { createConnection } = await import('net');
          const host = config.host as string;
          const port = (config.port as number) ?? 587;

          const result = await new Promise<string>((resolve, reject) => {
            const socket = createConnection({ host, port }, () => {
              socket.write(`EHLO bronco\r\n`);
            });
            let data = '';
            const timeout = setTimeout(() => { socket.destroy(); reject(new Error('SMTP connection timed out')); }, 10000);
            socket.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            socket.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
            // Wait for EHLO response then quit
            setTimeout(() => {
              socket.write('QUIT\r\n');
              setTimeout(() => { clearTimeout(timeout); socket.destroy(); resolve(data); }, 500);
            }, 2000);
          });

          const ok = result.includes('250');
          return {
            success: ok,
            message: ok ? `SMTP host ${host}:${port} is reachable (TCP/EHLO only — credentials not verified)` : `SMTP server responded but EHLO failed`,
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'SMTP connection failed' };
        }
      }

      if (row.type === 'PUSHOVER') {
        try {
          const appToken = looksEncrypted(config.appToken as string)
            ? decrypt(config.appToken as string, encryptionKey)
            : (config.appToken as string);
          const userKey = looksEncrypted(config.userKey as string)
            ? decrypt(config.userKey as string, encryptionKey)
            : (config.userKey as string);

          const res = await fetch('https://api.pushover.net/1/messages.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: appToken,
              user: userKey,
              title: 'Bronco — Test',
              message: 'Test notification from Bronco status monitoring.',
              priority: -1,
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) {
            const body = await res.text();
            return { success: false, error: `Pushover API returned ${res.status}: ${body}` };
          }
          return { success: true, message: 'Test push notification sent' };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Pushover send failed' };
        }
      }

      return { success: false, error: `Unknown channel type "${row.type}"` };
    },
  );
}
