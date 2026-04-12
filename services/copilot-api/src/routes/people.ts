import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const emailSchema = z.string().email('Invalid email format');

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as { code: string }).code === code;
}

export async function peopleRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/people?clientId=X
   * List people for a client, ordered by name.
   */
  fastify.get<{ Querystring: { clientId?: string } }>(
    '/api/people',
    async (request) => {
      const { clientId } = request.query;
      return fastify.db.person.findMany({
        where: {
          ...(clientId && { clientId }),
        },
        select: {
          id: true,
          clientId: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          slackUserId: true,
          isPrimary: true,
          hasPortalAccess: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
          client: { select: { name: true, shortCode: true } },
        },
        orderBy: { name: 'asc' },
      });
    },
  );

  /**
   * GET /api/people/:id
   */
  fastify.get<{ Params: { id: string } }>('/api/people/:id', async (request) => {
    const person = await fastify.db.person.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        clientId: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        slackUserId: true,
        isPrimary: true,
        hasPortalAccess: true,
        userType: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        client: { select: { name: true, shortCode: true } },
      },
    });
    if (!person) return fastify.httpErrors.notFound('Person not found');
    return person;
  });

  /**
   * POST /api/people
   * Create a person — either a contact-only or a portal user.
   */
  fastify.post<{
    Body: {
      clientId: string;
      name: string;
      email: string;
      phone?: string;
      role?: string;
      slackUserId?: string;
      isPrimary?: boolean;
      hasPortalAccess?: boolean;
      password?: string;
      userType?: string;
    };
  }>('/api/people', async (request, reply) => {
    const { clientId, name, email: rawEmail, phone, role, slackUserId, isPrimary, hasPortalAccess, password, userType } = request.body;

    if (!clientId || !name || !rawEmail) {
      return reply.code(400).send({ error: 'clientId, name, and email are required' });
    }

    const parsed = emailSchema.safeParse(rawEmail);
    if (!parsed.success) {
      return fastify.httpErrors.badRequest(parsed.error.issues[0].message);
    }
    const email = rawEmail.trim().toLowerCase();

    if (hasPortalAccess) {
      if (!password) {
        return reply.code(400).send({ error: 'password is required when hasPortalAccess is true' });
      }
      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }
      if (userType && userType !== 'ADMIN' && userType !== 'USER') {
        return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN or USER' });
      }
    }

    // Verify client exists
    const client = await fastify.db.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    const passwordHash = hasPortalAccess && password ? await bcrypt.hash(password, 10) : null;

    try {
      const person = await fastify.db.person.create({
        data: {
          clientId,
          name: name.trim(),
          email,
          phone: phone ?? null,
          role: role ?? null,
          slackUserId: slackUserId ?? null,
          isPrimary: isPrimary ?? false,
          hasPortalAccess: hasPortalAccess ?? false,
          ...(passwordHash ? { passwordHash } : {}),
          ...(hasPortalAccess ? { userType: (userType === 'ADMIN' ? 'ADMIN' : 'USER') as 'ADMIN' | 'USER' } : {}),
        },
        select: {
          id: true,
          clientId: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          slackUserId: true,
          isPrimary: true,
          hasPortalAccess: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      reply.code(201);
      return person;
    } catch (err) {
      if (isPrismaError(err, 'P2002')) {
        return reply.code(409).send({ error: 'A person with this email already exists for this client' });
      }
      throw err;
    }
  });

  /**
   * PATCH /api/people/:id
   */
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      email?: string;
      phone?: string | null;
      role?: string | null;
      slackUserId?: string | null;
      isPrimary?: boolean;
      hasPortalAccess?: boolean;
      password?: string;
      userType?: string;
      isActive?: boolean;
    };
  }>('/api/people/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, email: rawEmail, phone, role, slackUserId, isPrimary, hasPortalAccess, password, userType, isActive } = request.body;

    if (userType && userType !== 'ADMIN' && userType !== 'USER') {
      return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN or USER' });
    }

    const target = await fastify.db.person.findUnique({ where: { id } });
    if (!target) {
      return reply.code(404).send({ error: 'Person not found' });
    }

    // Enabling portal access requires a password to be set — otherwise the person cannot log in.
    // To set/change a password on an existing portal user, use POST /api/people/:id/reset-password.
    if (hasPortalAccess === true && !target.hasPortalAccess) {
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'password (minimum 8 characters) is required when enabling portal access' });
      }
    }

    const email = rawEmail?.trim().toLowerCase();
    if (email !== undefined) {
      const parsed = emailSchema.safeParse(email);
      if (!parsed.success) {
        return fastify.httpErrors.badRequest(parsed.error.issues[0].message);
      }
      const existing = await fastify.db.person.findFirst({ where: { clientId: target.clientId, email } });
      if (existing && existing.id !== id) {
        return reply.code(409).send({ error: 'Email is already in use for this client' });
      }
    }

    const newPasswordHash =
      hasPortalAccess === true && !target.hasPortalAccess && password
        ? await bcrypt.hash(password, 10)
        : undefined;

    try {
      return await fastify.db.person.update({
        where: { id },
        data: {
          ...(name !== undefined && { name: name.trim() }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...(role !== undefined && { role }),
          ...(slackUserId !== undefined && { slackUserId }),
          ...(isPrimary !== undefined && { isPrimary }),
          ...(hasPortalAccess !== undefined && { hasPortalAccess }),
          ...(newPasswordHash && { passwordHash: newPasswordHash }),
          ...(userType !== undefined && { userType: userType as 'ADMIN' | 'USER' }),
          ...(isActive !== undefined && { isActive }),
        },
        select: {
          id: true,
          clientId: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          slackUserId: true,
          isPrimary: true,
          hasPortalAccess: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Person not found');
      }
      throw err;
    }
  });

  /**
   * DELETE /api/people/:id
   * Deactivate portal users; hard-delete contact-only people.
   */
  fastify.delete<{ Params: { id: string } }>('/api/people/:id', async (request, reply) => {
    const target = await fastify.db.person.findUnique({ where: { id: request.params.id } });
    if (!target) {
      return reply.code(404).send({ error: 'Person not found' });
    }

    // Soft delete: portal users get deactivated so they retain historical ticket links
    if (target.hasPortalAccess) {
      await fastify.db.person.update({
        where: { id: request.params.id },
        data: { isActive: false },
      });
      return { message: 'Person deactivated' };
    }

    // Hard delete: contact-only people
    try {
      await fastify.db.person.delete({
        where: { id: request.params.id },
      });
      reply.code(204);
    } catch (err) {
      if (isPrismaError(err, 'P2025')) {
        return fastify.httpErrors.notFound('Person not found');
      }
      // P2003: foreign key constraint violation — person is referenced by ticket followers
      if (isPrismaError(err, 'P2003')) {
        return fastify.httpErrors.conflict('Cannot delete person — they are a follower on one or more tickets. Remove them from tickets first.');
      }
      throw err;
    }
  });

  /**
   * POST /api/people/:id/reset-password
   * Reset a portal user's password.
   */
  fastify.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/people/:id/reset-password',
    async (request, reply) => {
      const { id } = request.params;
      const { password } = request.body;

      if (!password || password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      const target = await fastify.db.person.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ error: 'Person not found' });
      }
      if (!target.hasPortalAccess) {
        return reply.code(400).send({ error: 'Person does not have portal access' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await fastify.db.person.update({
        where: { id },
        data: { passwordHash },
      });

      return { message: 'Password reset successfully' };
    },
  );
}
