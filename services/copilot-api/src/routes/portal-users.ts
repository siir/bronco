import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { ClientUserType } from '@bronco/shared-types';
import type { PortalUser } from '../plugins/auth.js';

// TODO: #219 Wave 2A — full portal-user admin CRUD against the unified
// Person + ClientUser model. Wave 1 reuses the existing endpoints with a
// minimal rewrite so the portal's "manage users" tab keeps working.

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
   */
  fastify.get('/api/portal/users', async (request) => {
    const portalUser = requirePortalAdmin(request);

    const clientUsers = await fastify.db.clientUser.findMany({
      where: { clientId: portalUser.clientId },
      // Explicit Person select — never expose passwordHash/emailLower.
      include: {
        person: { select: { id: true, name: true, email: true, isActive: true } },
      },
      orderBy: { person: { name: 'asc' } },
    });

    return clientUsers.map((cu) => ({
      id: cu.person.id,
      email: cu.person.email,
      name: cu.person.name,
      userType: cu.userType,
      isActive: cu.person.isActive,
      lastLoginAt: cu.lastLoginAt,
      createdAt: cu.createdAt,
    }));
  });

  /**
   * POST /api/portal/users
   */
  fastify.post<{ Body: { email: string; password: string; name: string; userType?: string } }>(
    '/api/portal/users',
    async (request, reply) => {
      const portalUser = requirePortalAdmin(request);
      const { email: rawEmail, password, name, userType } = request.body ?? {};

      if (!rawEmail || !password || !name) {
        return reply.code(400).send({ error: 'Email, password, and name are required' });
      }
      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }
      if (userType && userType !== ClientUserType.ADMIN && userType !== ClientUserType.USER) {
        return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN or USER' });
      }

      const email = rawEmail.trim();
      const emailLower = email.toLowerCase();
      const resolvedUserType = userType === ClientUserType.ADMIN ? ClientUserType.ADMIN : ClientUserType.USER;
      const passwordHash = await bcrypt.hash(password, 10);

      const existingPerson = await fastify.db.person.findUnique({
        where: { emailLower },
        include: { clientUsers: true },
      });

      const result = await fastify.db.$transaction(async (tx) => {
        let person = existingPerson;
        if (person) {
          const hasClientUser = person.clientUsers.some((c) => c.clientId === portalUser.clientId);
          if (hasClientUser) {
            throw Object.assign(new Error('A user with this email already exists'), { statusCode: 409 });
          }
          // Always use the caller-supplied password on re-add. Previously
          // `person.passwordHash ?? passwordHash` preserved a stale hash from
          // an earlier account incarnation, which meant a deleted-then-re-
          // added portal user could log in with their old password without
          // the admin knowing.
          person = await tx.person.update({
            where: { id: person.id },
            data: {
              passwordHash,
              name: name.trim(),
              isActive: true,
            },
            include: { clientUsers: true },
          });
        } else {
          person = await tx.person.create({
            data: { name: name.trim(), email, emailLower, passwordHash },
            include: { clientUsers: true },
          });
        }

        const cu = await tx.clientUser.create({
          data: {
            personId: person.id,
            clientId: portalUser.clientId,
            userType: resolvedUserType,
          },
        });

        return { person, cu };
      });

      return reply.code(201).send({
        id: result.person.id,
        email: result.person.email,
        name: result.person.name,
        userType: result.cu.userType,
        isActive: result.person.isActive,
        lastLoginAt: result.cu.lastLoginAt,
        createdAt: result.cu.createdAt,
      });
    },
  );

  /**
   * PATCH /api/portal/users/:id
   */
  fastify.patch<{ Params: { id: string }; Body: { name?: string; email?: string; userType?: string; isActive?: boolean } }>(
    '/api/portal/users/:id',
    async (request, reply) => {
      const portalUser = requirePortalAdmin(request);
      const { id } = request.params;
      const { name, email: rawEmail, userType, isActive } = request.body ?? {};

      if (userType && userType !== ClientUserType.ADMIN && userType !== ClientUserType.USER) {
        return reply.code(400).send({ error: 'Invalid userType. Must be ADMIN or USER' });
      }

      const cu = await fastify.db.clientUser.findFirst({
        where: { personId: id, clientId: portalUser.clientId },
        include: {
          person: { select: { id: true, name: true, email: true, isActive: true } },
        },
      });
      if (!cu) return reply.code(404).send({ error: 'User not found' });

      const email = rawEmail?.trim();
      const emailLower = email?.toLowerCase();
      if (emailLower && emailLower !== cu.person.email.toLowerCase()) {
        const existing = await fastify.db.person.findUnique({ where: { emailLower } });
        if (existing && existing.id !== id) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.$transaction(async (tx) => {
        const person = await tx.person.update({
          where: { id },
          data: {
            ...(name && { name: name.trim() }),
            ...(email && { email, emailLower: email.toLowerCase() }),
            ...(isActive !== undefined && { isActive }),
          },
        });

        const nextCu = userType
          ? await tx.clientUser.update({
              where: { id: cu.id },
              data: { userType: userType as ClientUserType },
            })
          : cu;

        return { person, cu: nextCu };
      });

      return {
        id: updated.person.id,
        email: updated.person.email,
        name: updated.person.name,
        userType: updated.cu.userType,
        isActive: updated.person.isActive,
        lastLoginAt: updated.cu.lastLoginAt,
        createdAt: updated.cu.createdAt,
      };
    },
  );

  /**
   * DELETE /api/portal/users/:id
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/portal/users/:id',
    async (request, reply) => {
      const portalUser = requirePortalAdmin(request);
      const { id } = request.params;

      if (id === portalUser.personId) {
        return reply.code(400).send({ error: 'Cannot revoke your own portal access' });
      }

      const cu = await fastify.db.clientUser.findFirst({
        where: { personId: id, clientId: portalUser.clientId },
      });
      if (!cu) return reply.code(404).send({ error: 'User not found' });

      await fastify.db.$transaction(async (tx) => {
        await tx.clientUser.delete({ where: { id: cu.id } });
        await tx.personRefreshToken.updateMany({
          where: { personId: id, accessType: 'CLIENT_USER', revokedAt: null },
          data: { revokedAt: new Date() },
        });

        // If the Person has no remaining ClientUser anywhere AND no Operator
        // record, they now have no way to authenticate — but their stored
        // passwordHash would survive and could be reused if an admin ever
        // re-adds them. Null it out so revocation actually revokes.
        const remaining = await tx.person.findUnique({
          where: { id },
          include: {
            operator: { select: { id: true } },
            _count: { select: { clientUsers: true } },
          },
        });
        if (remaining && !remaining.operator && remaining._count.clientUsers === 0) {
          await tx.person.update({ where: { id }, data: { passwordHash: null } });
        }
      });

      return { message: 'Portal access revoked' };
    },
  );
}
