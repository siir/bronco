import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  AccessType,
  CONSUMER_EMAIL_DOMAINS,
  ClientUserType,
  type PortalJwtPayload,
  type PortalLoginResponse,
  type PortalMeResponse,
  type PortalRefreshPayload,
} from '@bronco/shared-types';
import type { PortalUser } from '../plugins/auth.js';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function signPortalAccessToken(secret: string, payload: PortalJwtPayload): string {
  return jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function signPortalRefreshToken(secret: string, personId: string, clientUserId: string, jti: string): string {
  const payload: PortalRefreshPayload = { sub: personId, jti, clientUserId, type: 'portal_refresh' };
  return jwt.sign(payload, secret, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

export async function portalAuthRoutes(fastify: FastifyInstance): Promise<void> {
  async function issueRefreshToken(personId: string, clientUserId: string): Promise<string> {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await fastify.db.personRefreshToken.create({
      data: { jti, personId, accessType: AccessType.CLIENT_USER, clientUserId, expiresAt },
    });

    return signPortalRefreshToken(fastify.portalJwtSecret, personId, clientUserId, jti);
  }

  interface ResolvedPortalUser {
    person: { id: string; name: string; email: string; passwordHash: string | null; isActive: boolean };
    clientUser: { id: string; clientId: string; userType: ClientUserType; isPrimary: boolean };
    client: { name: string; shortCode: string };
  }

  async function resolveForLogin(emailLower: string, preferredClientId?: string): Promise<ResolvedPortalUser | null> {
    const person = await fastify.db.person.findUnique({
      where: { emailLower },
      include: {
        clientUsers: {
          // Deterministic order when the caller didn't specify clientId:
          // primary contacts first, then oldest-created. Without this
          // Prisma's ordering is undefined and multi-client Persons could
          // land in the wrong tenant.
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include: { client: { select: { id: true, name: true, shortCode: true } } },
        },
      },
    });
    if (!person || !person.isActive || !person.passwordHash) return null;
    if (person.clientUsers.length === 0) return null;

    const cu = preferredClientId
      ? person.clientUsers.find((c) => c.clientId === preferredClientId)
      : person.clientUsers[0];
    if (!cu) return null;

    return {
      person: {
        id: person.id,
        name: person.name,
        email: person.email,
        passwordHash: person.passwordHash,
        isActive: person.isActive,
      },
      clientUser: {
        id: cu.id,
        clientId: cu.clientId,
        userType: cu.userType,
        isPrimary: cu.isPrimary,
      },
      client: { name: cu.client.name, shortCode: cu.client.shortCode },
    };
  }

  function buildPortalMe(resolved: ResolvedPortalUser): PortalMeResponse {
    return {
      personId: resolved.person.id,
      clientUserId: resolved.clientUser.id,
      email: resolved.person.email,
      name: resolved.person.name,
      userType: resolved.clientUser.userType,
      clientId: resolved.clientUser.clientId,
      isPrimary: resolved.clientUser.isPrimary,
    };
  }

  function toLoginResponse(
    resolved: ResolvedPortalUser,
    accessToken: string,
    refreshToken: string,
  ): PortalLoginResponse {
    return { accessToken, refreshToken, user: buildPortalMe(resolved) };
  }

  /**
   * POST /api/portal/auth/login
   */
  fastify.post<{ Body: { email: string; password: string; clientId?: string } }>(
    '/api/portal/auth/login',
    async (request, reply) => {
      const { email, password, clientId } = request.body ?? {};
      if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
      }

      const emailLower = email.trim().toLowerCase();
      const resolved = await resolveForLogin(emailLower, clientId);
      if (!resolved) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const valid = await bcrypt.compare(password, resolved.person.passwordHash!);
      if (!valid) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      await fastify.db.clientUser.update({
        where: { id: resolved.clientUser.id },
        data: { lastLoginAt: new Date() },
      });

      const accessToken = signPortalAccessToken(fastify.portalJwtSecret, {
        sub: resolved.person.id,
        clientUserId: resolved.clientUser.id,
        email: resolved.person.email,
        clientId: resolved.clientUser.clientId,
        userType: resolved.clientUser.userType,
        type: 'portal_access',
        name: resolved.person.name,
      });
      const refreshToken = await issueRefreshToken(resolved.person.id, resolved.clientUser.id);

      return toLoginResponse(resolved, accessToken, refreshToken);
    },
  );

  /**
   * POST /api/portal/auth/refresh
   */
  fastify.post<{ Body: { refreshToken: string } }>(
    '/api/portal/auth/refresh',
    async (request, reply) => {
      const { refreshToken } = request.body ?? {};
      if (!refreshToken) {
        return reply.code(400).send({ error: 'Refresh token is required' });
      }

      let payload: PortalRefreshPayload;
      try {
        payload = jwt.verify(refreshToken, fastify.portalJwtSecret) as PortalRefreshPayload;
      } catch {
        return reply.code(401).send({ error: 'Invalid or expired refresh token' });
      }

      if (payload.type !== 'portal_refresh') {
        return reply.code(401).send({ error: 'Invalid token type' });
      }

      if (payload.jti) {
        const result = await fastify.db.personRefreshToken.updateMany({
          where: { jti: payload.jti, accessType: AccessType.CLIENT_USER, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (result.count === 0) {
          return reply.code(401).send({ error: 'Refresh token has been revoked' });
        }
      }

      // Pin the refresh to the exact ClientUser the token was issued for.
      // Without this a Person with ClientUsers across multiple tenants could
      // silently hop tenants on refresh.
      if (!payload.clientUserId) {
        return reply.code(401).send({ error: 'Invalid refresh token' });
      }

      // Explicit Person select — never pull `passwordHash` into memory on
      // refresh. Defense-in-depth against future edits that spread the row.
      const clientUser = await fastify.db.clientUser.findUnique({
        where: { id: payload.clientUserId },
        select: {
          id: true,
          personId: true,
          clientId: true,
          userType: true,
          person: { select: { id: true, name: true, email: true, isActive: true } },
        },
      });

      if (
        !clientUser ||
        clientUser.personId !== payload.sub ||
        !clientUser.person.isActive
      ) {
        return reply.code(401).send({ error: 'User not found or inactive' });
      }

      const newAccessToken = signPortalAccessToken(fastify.portalJwtSecret, {
        sub: clientUser.person.id,
        clientUserId: clientUser.id,
        email: clientUser.person.email,
        clientId: clientUser.clientId,
        userType: clientUser.userType,
        type: 'portal_access',
        name: clientUser.person.name,
      });
      const newRefreshToken = await issueRefreshToken(clientUser.person.id, clientUser.id);

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    },
  );

  /**
   * POST /api/portal/auth/register
   */
  fastify.post<{ Body: { email: string; password: string; name: string } }>(
    '/api/portal/auth/register',
    async (request, reply) => {
      const { email: rawEmail, password, name } = request.body ?? {};
      if (!rawEmail || !password || !name) {
        return reply.code(400).send({ error: 'Email, password, and name are required' });
      }

      const email = rawEmail.trim();
      const emailLower = email.toLowerCase();
      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      const atIndex = emailLower.indexOf('@');
      if (atIndex === -1) {
        return reply.code(400).send({ error: 'Invalid email address' });
      }
      const domain = emailLower.slice(atIndex + 1);

      if ((CONSUMER_EMAIL_DOMAINS as readonly string[]).includes(domain)) {
        return reply.code(400).send({ error: 'Please use your company email address to register' });
      }

      const client = await fastify.db.client.findFirst({
        where: {
          domainMappings: { has: domain },
          isActive: true,
          allowSelfRegistration: true,
        },
        select: { id: true, name: true, shortCode: true },
      });

      if (!client) {
        return reply.code(400).send({
          error: 'No matching organization found for your email domain, or self-registration is not enabled',
        });
      }

      // SECURITY: Self-registration MUST NOT grant a session for an existing
      // Person. The pre-fix code accepted the /register call for anyone who
      // controlled a domain-mapped email address and then issued tokens for
      // the existing Person — effectively a session hijack (including of
      // operator accounts). Reject outright; the caller must use /login
      // instead. Linking an existing Person to a new client is an
      // authenticated operation that doesn't belong on this endpoint.
      const existingPerson = await fastify.db.person.findUnique({
        where: { emailLower },
        select: { id: true },
      });
      if (existingPerson) {
        return reply
          .code(409)
          .send({ error: 'An account with this email already exists. Please log in instead.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const { person, clientUser } = await fastify.db.$transaction(async (tx) => {
        const person = await tx.person.create({
          data: {
            name: name.trim(),
            email,
            emailLower,
            passwordHash,
          },
        });

        const clientUser = await tx.clientUser.create({
          data: {
            personId: person.id,
            clientId: client.id,
            userType: ClientUserType.USER,
          },
        });

        return { person, clientUser };
      });

      const accessToken = signPortalAccessToken(fastify.portalJwtSecret, {
        sub: person.id,
        clientUserId: clientUser.id,
        email: person.email,
        clientId: client.id,
        userType: clientUser.userType,
        type: 'portal_access',
        name: person.name,
      });
      const refreshToken = await issueRefreshToken(person.id, clientUser.id);

      const resolved: ResolvedPortalUser = {
        person: {
          id: person.id,
          name: person.name,
          email: person.email,
          passwordHash: person.passwordHash,
          isActive: person.isActive,
        },
        clientUser: {
          id: clientUser.id,
          clientId: clientUser.clientId,
          userType: clientUser.userType,
          isPrimary: clientUser.isPrimary,
        },
        client: { name: client.name, shortCode: client.shortCode },
      };
      const response: PortalLoginResponse = {
        accessToken,
        refreshToken,
        user: buildPortalMe(resolved),
      };
      return response;
    },
  );

  /**
   * GET /api/portal/auth/me
   */
  fastify.get('/api/portal/auth/me', async (request, reply) => {
    const portalUser = request.portalUser as PortalUser | undefined;
    if (!portalUser) {
      return reply.code(401).send({ error: 'Portal authentication required' });
    }

    // Explicit Person select — don't use `include: { person: true }` which
    // would expose passwordHash and emailLower on the /me response.
    const cu = await fastify.db.clientUser.findUnique({
      where: { id: portalUser.clientUserId },
      select: {
        id: true,
        clientId: true,
        userType: true,
        isPrimary: true,
        person: {
          select: {
            id: true,
            name: true,
            email: true,
            isActive: true,
          },
        },
        client: { select: { name: true, shortCode: true } },
      },
    });

    if (!cu || !cu.person.isActive) {
      return reply.code(401).send({ error: 'User not found or inactive' });
    }

    const response: PortalMeResponse = {
      personId: cu.person.id,
      clientUserId: cu.id,
      email: cu.person.email,
      name: cu.person.name,
      userType: cu.userType,
      clientId: cu.clientId,
      isPrimary: cu.isPrimary,
    };
    return response;
  });

  /**
   * PATCH /api/portal/auth/profile
   */
  fastify.patch<{ Body: { name?: string; email?: string } }>(
    '/api/portal/auth/profile',
    async (request, reply) => {
      const portalUser = request.portalUser as PortalUser | undefined;
      if (!portalUser) {
        return reply.code(401).send({ error: 'Portal authentication required' });
      }

      const { name, email: rawEmail } = request.body ?? {};
      const email = rawEmail?.trim();
      if (!name && !email) {
        return reply.code(400).send({ error: 'At least one of name or email is required' });
      }

      const emailLower = email?.toLowerCase();
      if (emailLower) {
        const existing = await fastify.db.person.findUnique({ where: { emailLower } });
        if (existing && existing.id !== portalUser.personId) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.person.update({
        where: { id: portalUser.personId },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email, emailLower: email.toLowerCase() }),
        },
      });

      return {
        personId: updated.id,
        email: updated.email,
        name: updated.name,
        clientId: portalUser.clientId,
        userType: portalUser.userType,
      };
    },
  );

  /**
   * POST /api/portal/auth/change-password
   */
  fastify.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/portal/auth/change-password',
    async (request, reply) => {
      const portalUser = request.portalUser as PortalUser | undefined;
      if (!portalUser) {
        return reply.code(401).send({ error: 'Portal authentication required' });
      }

      const { currentPassword, newPassword } = request.body ?? {};
      if (!currentPassword || !newPassword) {
        return reply.code(400).send({ error: 'Current password and new password are required' });
      }
      if (newPassword.length < 8) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }

      const person = await fastify.db.person.findUnique({ where: { id: portalUser.personId } });
      if (!person || !person.passwordHash) {
        return reply.code(401).send({ error: 'User not found' });
      }

      const valid = await bcrypt.compare(currentPassword, person.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: 'Current password is incorrect' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await fastify.db.person.update({
        where: { id: portalUser.personId },
        data: { passwordHash },
      });

      return { message: 'Password changed successfully' };
    },
  );
}
