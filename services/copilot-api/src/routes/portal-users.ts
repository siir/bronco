import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { ClientUserType } from '@bronco/shared-types';
import type { PortalUser } from '../plugins/auth.js';

function requirePortalAdmin(request: { portalUser?: PortalUser }): PortalUser {
  if (!request.portalUser) {
    const err = Object.assign(new Error('Portal authentication required'), { statusCode: 401 });
    throw err;
  }
  if (request.portalUser.userType !== ClientUserType.ADMIN) {
    const err = Object.assign(new Error('Admin access required'), { statusCode: 403 });
    throw err;
  }
  return request.portalUser;
}

export async function portalUserRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/portal/users
   * List all portal users for this client (ADMIN only).
   */
  fastify.get('/api/portal/users', async (request) => {
    const portalUser = requirePortalAdmin(request);

    const users = await fastify.db.person.findMany({
      where: { clientId: portalUser.clientId, hasPortalAccess: true },
      select: {
        id: true,
        email: true,
        name: true,
        userType: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { name: 'asc' },
    });

    return users;
  });

  /**
   * POST /api/portal/users
   * Create or grant portal access to a person (ADMIN only).
   */
  fastify.post<{ Body: { email: string; password: string; name: string; userType?: string } }>(
    '/api/portal/users',
    async (request, reply) => {
      const portalUser = requirePortalAdmin(request);
      const { email: rawEmail, password, name, userType } = request.body;

      if (!rawEmail || !password || !name) {
        return reply.code(400).send({ error: 'Email, password, and name are required' });
      }

      const email = rawEmail.trim().toLowerCase();

      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      if (userType && userType !== ClientUserType.ADMIN && userType !== ClientUserType.USER) {
        return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN or USER' });
      }

      const resolvedUserType = userType === ClientUserType.ADMIN ? ClientUserType.ADMIN : ClientUserType.USER;
      const passwordHash = await bcrypt.hash(password, 10);

      const existing = await fastify.db.person.findUnique({
        where: { clientId_email: { clientId: portalUser.clientId, email } },
      });

      let user;
      if (existing) {
        if (existing.hasPortalAccess) {
          return reply.code(409).send({ error: 'A user with this email already exists' });
        }
        // Upgrade existing contact to portal user
        user = await fastify.db.person.update({
          where: { id: existing.id },
          data: {
            name: name.trim(),
            passwordHash,
            hasPortalAccess: true,
            userType: resolvedUserType,
            isActive: true,
          },
          select: {
            id: true,
            email: true,
            name: true,
            userType: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
          },
        });
      } else {
        user = await fastify.db.person.create({
          data: {
            email,
            passwordHash,
            name: name.trim(),
            clientId: portalUser.clientId,
            userType: resolvedUserType,
            hasPortalAccess: true,
          },
          select: {
            id: true,
            email: true,
            name: true,
            userType: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
          },
        });
      }

      return reply.code(201).send(user);
    },
  );

  /**
   * PATCH /api/portal/users/:id
   * Update a portal user (ADMIN only).
   */
  fastify.patch<{ Params: { id: string }; Body: { name?: string; email?: string; userType?: string; isActive?: boolean } }>(
    '/api/portal/users/:id',
    async (request, reply) => {
      const portalUser = requirePortalAdmin(request);
      const { id } = request.params;
      const { name, email: rawEmail, userType, isActive } = request.body;

      if (userType && userType !== ClientUserType.ADMIN && userType !== ClientUserType.USER) {
        return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN or USER' });
      }

      // Verify user belongs to same client and has portal access
      const target = await fastify.db.person.findUnique({ where: { id } });
      if (!target || target.clientId !== portalUser.clientId || !target.hasPortalAccess) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const email = rawEmail?.trim().toLowerCase();
      if (email && email !== target.email) {
        const existing = await fastify.db.person.findUnique({
          where: { clientId_email: { clientId: portalUser.clientId, email } },
        });
        if (existing && existing.id !== id) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.person.update({
        where: { id },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email }),
          ...(userType && { userType: userType as 'ADMIN' | 'USER' }),
          ...(isActive !== undefined && { isActive }),
        },
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });

      return updated;
    },
  );

  /**
   * DELETE /api/portal/users/:id
   * Revoke portal access (ADMIN only). Does not delete the underlying Person.
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/portal/users/:id',
    async (request, reply) => {
      const portalUser = requirePortalAdmin(request);
      const { id } = request.params;

      // Cannot deactivate yourself
      if (id === portalUser.id) {
        return reply.code(400).send({ error: 'Cannot deactivate your own account' });
      }

      const target = await fastify.db.person.findUnique({ where: { id } });
      if (!target || target.clientId !== portalUser.clientId || !target.hasPortalAccess) {
        return reply.code(404).send({ error: 'User not found' });
      }

      await fastify.db.person.update({
        where: { id },
        data: { isActive: false },
      });

      return { message: 'User deactivated' };
    },
  );
}
