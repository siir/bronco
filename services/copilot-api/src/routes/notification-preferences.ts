import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@bronco/db';
import { NotificationEvent, NotificationEventDescriptions } from '@bronco/shared-types';
import type { NotificationEvent as NotificationEventType } from '@bronco/shared-types';
import { z } from 'zod';

const ALL_EVENTS = Object.values(NotificationEvent) as NotificationEventType[];

const upsertSchema = z.object({
  emailEnabled: z.boolean().optional(),
  slackEnabled: z.boolean().optional(),
  slackTarget: z.string().nullable().optional(),
  emailTarget: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

const bulkUpsertSchema = z.array(
  z.object({
    event: z.string().refine((v): v is NotificationEventType => ALL_EVENTS.includes(v as NotificationEventType), { message: 'Invalid notification event' }),
    emailEnabled: z.boolean().optional(),
    slackEnabled: z.boolean().optional(),
    slackTarget: z.string().nullable().optional(),
    emailTarget: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  }),
);

/** Ensure default preferences exist for all events. Returns all preferences. */
async function ensureDefaults(db: PrismaClient) {
  const existing = await db.notificationPreference.findMany();
  const existingEvents = new Set(existing.map((p: { event: string }) => p.event));
  const missing = ALL_EVENTS.filter(e => !existingEvents.has(e));

  if (missing.length > 0) {
    await db.notificationPreference.createMany({
      data: missing.map(event => ({
        event,
        emailEnabled: true,
        slackEnabled: false,
        slackTarget: null,
        emailTarget: 'all_operators',
        isActive: true,
      })),
    });
    return db.notificationPreference.findMany({ orderBy: { event: 'asc' } });
  }

  return existing.sort((a: { event: string }, b: { event: string }) => a.event.localeCompare(b.event));
}

export async function notificationPreferenceRoutes(fastify: FastifyInstance): Promise<void> {
  const db = fastify.db;

  // GET /api/notification-preferences — list all (seed defaults for missing events)
  fastify.get('/api/notification-preferences', async (_req, reply) => {
    const prefs = await ensureDefaults(db);
    const result = prefs.map((p: { event: string }) => ({
      ...p,
      description: NotificationEventDescriptions[p.event as NotificationEventType] ?? p.event,
    }));
    return reply.send(result);
  });

  // PUT /api/notification-preferences/:event — upsert a single event preference
  fastify.put<{ Params: { event: string }; Body: unknown }>(
    '/api/notification-preferences/:event',
    async (req, reply) => {
      const event = req.params.event;
      if (!ALL_EVENTS.includes(event as NotificationEventType)) {
        return reply.status(400).send({ error: `Invalid event: ${event}` });
      }

      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const pref = await db.notificationPreference.upsert({
        where: { event },
        update: parsed.data,
        create: {
          event,
          emailEnabled: parsed.data.emailEnabled ?? true,
          slackEnabled: parsed.data.slackEnabled ?? false,
          slackTarget: parsed.data.slackTarget ?? null,
          emailTarget: parsed.data.emailTarget ?? 'all_operators',
          isActive: parsed.data.isActive ?? true,
        },
      });

      return reply.send(pref);
    },
  );

  // PUT /api/notification-preferences — bulk upsert all preferences
  fastify.put<{ Body: unknown }>('/api/notification-preferences', async (req, reply) => {
    const parsed = bulkUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const results = await Promise.all(
      parsed.data.map(item =>
        db.notificationPreference.upsert({
          where: { event: item.event },
          update: {
            emailEnabled: item.emailEnabled,
            slackEnabled: item.slackEnabled,
            slackTarget: item.slackTarget,
            emailTarget: item.emailTarget,
            isActive: item.isActive,
          },
          create: {
            event: item.event,
            emailEnabled: item.emailEnabled ?? true,
            slackEnabled: item.slackEnabled ?? false,
            slackTarget: item.slackTarget ?? null,
            emailTarget: item.emailTarget ?? 'all_operators',
            isActive: item.isActive ?? true,
          },
        }),
      ),
    );

    return reply.send(results);
  });
}
