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

      // Under the unified Person model, Person is global — a single identity
      // row can have ClientUser associations across many clients and/or an
      // Operator record. This endpoint is the client-scoped portal-admin
      // surface; it must NOT be able to overwrite credentials, flip
      // activation, or rename a Person that exists in another context
      // (another tenant, or as an Operator). Otherwise a portal admin at
      // Client A could reset an operator's password via this route.
      const existingPerson = await fastify.db.person.findUnique({
        where: { emailLower },
        include: {
          clientUsers: true,
          operator: { select: { id: true } },
        },
      });

      const result = await fastify.db.$transaction(async (tx) => {
        if (!existingPerson) {
          // Case A — fresh Person: create Person + ClientUser.
          const person = await tx.person.create({
            data: { name: name.trim(), email, emailLower, passwordHash },
          });
          const cu = await tx.clientUser.create({
            data: {
              personId: person.id,
              clientId: portalUser.clientId,
              userType: resolvedUserType,
            },
          });
          return { person, cu };
        }

        const cuHere = existingPerson.clientUsers.find((c) => c.clientId === portalUser.clientId);

        if (cuHere) {
          // Case B — Person already linked to this client.
          if (existingPerson.passwordHash) {
            // Already has credentials — portal admin cannot overwrite.
            throw Object.assign(new Error('A user with this email already exists'), { statusCode: 409 });
          }
          // Upgrade path: existing bare contact linked to this client,
          // getting credentialed for the first time. Set passwordHash and
          // update userType. Do NOT touch name/isActive — those are global
          // to the Person and belong to operator-level management.
          const person = await tx.person.update({
            where: { id: existingPerson.id },
            data: { passwordHash },
          });
          const cu = await tx.clientUser.update({
            where: { id: cuHere.id },
            data: { userType: resolvedUserType },
          });
          return { person, cu };
        }

        // Case C — Person exists but not linked to this client. This could
        // be an Operator, a ClientUser at another tenant, or a contact
        // elsewhere. Portal admin must not be able to silently claim that
        // identity. Reject as if the email were globally taken.
        throw Object.assign(new Error('A user with this email already exists'), { statusCode: 409 });
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
   *
   * Portal admins can only mutate ClientUser fields scoped to their own
   * client. Person-level fields (name, email, isActive) are global under the
   * unified identity model and are NOT editable from this surface — a portal
   * admin at Client A changing a person's email here would propagate across
   * every tenant that person is linked to, and could deactivate an Operator.
   *
   * Users edit their own name/email via `PATCH /api/portal/auth/profile`.
   * Operator-level changes go through the control-panel `/api/people` surface.
   */
  fastify.patch<{ Params: { id: string }; Body: { userType?: string; isPrimary?: boolean } }>(
    '/api/portal/users/:id',
    async (request, reply) => {
      const portalUser = requirePortalAdmin(request);
      const { id } = request.params;
      const { userType, isPrimary } = request.body ?? {};

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

      const updated = await fastify.db.clientUser.update({
        where: { id: cu.id },
        data: {
          ...(userType !== undefined && { userType: userType as ClientUserType }),
          ...(isPrimary !== undefined && { isPrimary }),
        },
        include: {
          person: { select: { id: true, name: true, email: true, isActive: true } },
        },
      });

      return {
        id: updated.person.id,
        email: updated.person.email,
        name: updated.person.name,
        userType: updated.userType,
        isActive: updated.person.isActive,
        isPrimary: updated.isPrimary,
        lastLoginAt: updated.lastLoginAt,
        createdAt: updated.createdAt,
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
