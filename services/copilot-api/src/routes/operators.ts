import type { FastifyInstance } from 'fastify';
import { OperatorRole } from '@bronco/shared-types';
import type { AuthUser } from '../plugins/auth.js';

interface OperatorResponse {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  isAdmin: boolean;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  personId: string;
  clientId: string | null;
  role: string;
}

function flatten(op: {
  id: string;
  personId: string;
  clientId: string | null;
  role: string;
  notifyEmail: boolean;
  notifySlack: boolean;
  slackUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  person: { email: string; name: string; isActive: boolean };
}): OperatorResponse {
  return {
    id: op.id,
    email: op.person.email,
    name: op.person.name,
    isActive: op.person.isActive,
    isAdmin: op.role === 'ADMIN',
    notifyEmail: op.notifyEmail,
    notifySlack: op.notifySlack,
    slackUserId: op.slackUserId,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    personId: op.personId,
    clientId: op.clientId,
    role: op.role,
  };
}

export async function operatorRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Require platform ADMIN for all operator-management routes.
   *
   * The registration group in routes/index.ts gates this at
   * `requireRole(ADMIN, STANDARD)` — which is too permissive here.
   * Operator CRUD is privilege-granting: a STANDARD operator who can create
   * or PATCH operator rows can promote themselves to ADMIN, which is a full
   * control-plane takeover. We apply an additional internal gate so only
   * ADMIN can reach any handler on this router.
   *
   * Service-to-service (API-key) callers have no `request.user` and fall
   * through — they're trusted by the outer plugin.
   */
  fastify.addHook('preHandler', async (request, reply) => {
    const authUser = request.user as AuthUser | undefined;
    if (!authUser) return; // API-key authenticated; outer plugin trusted it.
    if (authUser.role !== OperatorRole.ADMIN) {
      return reply.code(403).send({ error: 'Only admins can manage operators' });
    }
  });

  /**
   * GET /api/operators
   */
  fastify.get<{ Querystring: { includeInactive?: string } }>(
    '/api/operators',
    async (request) => {
      const includeInactive = request.query.includeInactive === 'true';
      const operators = await fastify.db.operator.findMany({
        where: includeInactive ? {} : { person: { isActive: true } },
        include: { person: { select: { email: true, name: true, isActive: true } } },
        orderBy: { person: { name: 'asc' } },
      });
      return operators.map(flatten);
    },
  );

  /**
   * GET /api/operators/:id
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/operators/:id',
    async (request) => {
      const operator = await fastify.db.operator.findUnique({
        where: { id: request.params.id },
        include: { person: { select: { email: true, name: true, isActive: true } } },
      });
      if (!operator) return fastify.httpErrors.notFound('Operator not found');
      return flatten(operator);
    },
  );

  /**
   * POST /api/operators
   */
  fastify.post<{
    Body: {
      email: string;
      name: string;
      notifyEmail?: boolean;
      notifySlack?: boolean;
      slackUserId?: string;
    };
  }>('/api/operators', async (request, reply) => {
    const { email: rawEmail, name, notifyEmail, notifySlack, slackUserId } = request.body ?? {};

    if (!rawEmail || !name) {
      return reply.code(400).send({ error: 'Email and name are required' });
    }

    const email = rawEmail.trim();
    const emailLower = email.toLowerCase();

    // Only need id (for upsert) + operator presence (for conflict check).
    const existingPerson = await fastify.db.person.findUnique({
      where: { emailLower },
      select: { id: true, operator: { select: { id: true } } },
    });
    if (existingPerson?.operator) {
      return reply.code(409).send({ error: 'An operator with this email already exists' });
    }

    const trimmedSlackUserId = slackUserId !== undefined ? (slackUserId.trim() || null) : undefined;

    const operator = await fastify.db.$transaction(async (tx) => {
      const person = existingPerson
        ? await tx.person.update({
            where: { id: existingPerson.id },
            // Reactivate on promotion — Person.isActive is the master auth
            // switch, so a previously deactivated Person must be flipped back
            // on when they're granted an Operator record. Matches the
            // /api/users promotion flow.
            data: { name: name.trim(), isActive: true },
          })
        : await tx.person.create({
            data: { email, emailLower, name: name.trim() },
          });

      return tx.operator.create({
        data: {
          personId: person.id,
          ...(notifyEmail !== undefined && { notifyEmail }),
          ...(notifySlack !== undefined && { notifySlack }),
          ...(trimmedSlackUserId !== undefined && { slackUserId: trimmedSlackUserId }),
        },
        include: { person: { select: { email: true, name: true, isActive: true } } },
      });
    });

    return reply.code(201).send(flatten(operator));
  });

  /**
   * PATCH /api/operators/:id
   */
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      email?: string;
      isActive?: boolean;
      role?: string;
      clientId?: string | null;
      notifyEmail?: boolean;
      notifySlack?: boolean;
      slackUserId?: string | null;
    };
  }>('/api/operators/:id', async (request, reply) => {
    const { id } = request.params;
    const { name, email: rawEmail, isActive, role, clientId, notifyEmail, notifySlack, slackUserId } = request.body ?? {};

    const target = await fastify.db.operator.findUnique({
      where: { id },
      include: { person: { select: { email: true, name: true, isActive: true } } },
    });
    if (!target) {
      return reply.code(404).send({ error: 'Operator not found' });
    }

    if (role !== undefined && role !== OperatorRole.ADMIN && role !== OperatorRole.STANDARD) {
      return reply.code(400).send({ error: `Invalid role. Must be ADMIN or STANDARD` });
    }

    const email = rawEmail?.trim();
    const emailLower = email?.toLowerCase();
    if (emailLower) {
      // Only id needed for the conflict check.
      const existing = await fastify.db.person.findUnique({
        where: { emailLower },
        select: { id: true },
      });
      if (existing && existing.id !== target.personId) {
        return reply.code(409).send({ error: 'Email is already in use by another operator' });
      }
    }

    const trimmedSlackUserId =
      slackUserId !== undefined
        ? typeof slackUserId === 'string'
          ? slackUserId.trim() || null
          : null
        : undefined;

    // clientId: undefined means "don't change"; null means "clear to platform-wide"
    const clientIdUpdate =
      clientId !== undefined ? (clientId === null ? { clientId: null } : { clientId }) : {};

    const updated = await fastify.db.$transaction(async (tx) => {
      await tx.person.update({
        where: { id: target.personId },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email, emailLower: email.toLowerCase() }),
          ...(isActive !== undefined && { isActive }),
        },
      });

      return tx.operator.update({
        where: { id },
        data: {
          ...(role !== undefined && { role: role as OperatorRole }),
          ...clientIdUpdate,
          ...(notifyEmail !== undefined && { notifyEmail }),
          ...(notifySlack !== undefined && { notifySlack }),
          ...(trimmedSlackUserId !== undefined && { slackUserId: trimmedSlackUserId }),
        },
        include: { person: { select: { email: true, name: true, isActive: true } } },
      });
    });

    return flatten(updated);
  });

  /**
   * DELETE /api/operators/:id
   */
  fastify.delete<{ Params: { id: string } }>(
    '/api/operators/:id',
    async (request) => {
      const { id } = request.params;

      const target = await fastify.db.operator.findUnique({ where: { id } });
      if (!target) return fastify.httpErrors.notFound('Operator not found');

      await fastify.db.person.update({
        where: { id: target.personId },
        data: { isActive: false },
      });

      return { message: 'Operator deactivated' };
    },
  );
}
