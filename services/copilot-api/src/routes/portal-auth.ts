import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { CONSUMER_EMAIL_DOMAINS, type ClientUserType } from '@bronco/shared-types';
import type { PortalUser } from '../plugins/auth.js';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function signPortalAccessToken(
  secret: string,
  user: { id: string; email: string; clientId: string; userType: ClientUserType; hasOpsAccess: boolean },
): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      clientId: user.clientId,
      userType: user.userType,
      hasOpsAccess: user.hasOpsAccess,
      type: 'portal_access',
    },
    secret,
    { expiresIn: ACCESS_TOKEN_EXPIRY },
  );
}

function signPortalRefreshToken(secret: string, userId: string, jti: string): string {
  return jwt.sign({ sub: userId, jti, type: 'portal_refresh' }, secret, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
}

export async function portalAuthRoutes(fastify: FastifyInstance): Promise<void> {
  async function issueRefreshToken(personId: string): Promise<string> {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await fastify.db.personRefreshToken.create({
      data: { jti, personId, expiresAt },
    });

    return signPortalRefreshToken(fastify.portalJwtSecret, personId, jti);
  }

  /**
   * POST /api/portal/auth/login
   */
  fastify.post<{ Body: { email: string; password: string; clientId?: string } }>(
    '/api/portal/auth/login',
    async (request, reply) => {
      const { email, password, clientId } = request.body;

      if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
      }

      const emailNorm = email.trim().toLowerCase();
      const user = clientId
        ? await fastify.db.person.findUnique({
            where: { clientId_email: { clientId, email: emailNorm } },
            include: { client: { select: { name: true, shortCode: true } } },
          })
        : await fastify.db.person.findFirst({
            where: { email: emailNorm, hasPortalAccess: true },
            include: { client: { select: { name: true, shortCode: true } } },
          });

      if (!user || !user.isActive || !user.hasPortalAccess || !user.passwordHash) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      await fastify.db.person.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const userType = (user.userType ?? 'USER') as ClientUserType;
      const accessToken = signPortalAccessToken(fastify.portalJwtSecret, {
        id: user.id,
        email: user.email,
        clientId: user.clientId,
        userType,
        hasOpsAccess: user.hasOpsAccess,
      });
      const refreshToken = await issueRefreshToken(user.id);

      return {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          clientId: user.clientId,
          userType,
          hasOpsAccess: user.hasOpsAccess,
          client: user.client,
        },
      };
    },
  );

  /**
   * POST /api/portal/auth/refresh
   */
  fastify.post<{ Body: { refreshToken: string } }>(
    '/api/portal/auth/refresh',
    async (request, reply) => {
      const { refreshToken } = request.body;

      if (!refreshToken) {
        return reply.code(400).send({ error: 'Refresh token is required' });
      }

      let payload: { sub: string; jti?: string; type?: string };
      try {
        payload = jwt.verify(refreshToken, fastify.portalJwtSecret) as { sub: string; jti?: string; type?: string };
      } catch {
        return reply.code(401).send({ error: 'Invalid or expired refresh token' });
      }

      if (payload.type !== 'portal_refresh') {
        return reply.code(401).send({ error: 'Invalid token type' });
      }

      if (payload.jti) {
        const result = await fastify.db.personRefreshToken.updateMany({
          where: { jti: payload.jti, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        if (result.count === 0) {
          return reply.code(401).send({ error: 'Refresh token has been revoked' });
        }
      }

      const user = await fastify.db.person.findUnique({ where: { id: payload.sub } });

      if (!user || !user.isActive || !user.hasPortalAccess) {
        return reply.code(401).send({ error: 'User not found or inactive' });
      }

      const userType = (user.userType ?? 'USER') as ClientUserType;
      const newAccessToken = signPortalAccessToken(fastify.portalJwtSecret, {
        id: user.id,
        email: user.email,
        clientId: user.clientId,
        userType,
        hasOpsAccess: user.hasOpsAccess,
      });
      const newRefreshToken = await issueRefreshToken(user.id);

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    },
  );

  /**
   * POST /api/portal/auth/register
   * Self-registration for client users. Requires:
   * - Email domain matches a client's domainMappings
   * - Client has allowSelfRegistration = true
   * - Email is not a consumer domain
   */
  fastify.post<{ Body: { email: string; password: string; name: string } }>(
    '/api/portal/auth/register',
    async (request, reply) => {
      const { email: rawEmail, password, name } = request.body;

      if (!rawEmail || !password || !name) {
        return reply.code(400).send({ error: 'Email, password, and name are required' });
      }

      const email = rawEmail.trim().toLowerCase();

      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      // Extract domain
      const atIndex = email.indexOf('@');
      if (atIndex === -1) {
        return reply.code(400).send({ error: 'Invalid email address' });
      }
      const domain = email.slice(atIndex + 1);

      // Check consumer domains
      if ((CONSUMER_EMAIL_DOMAINS as readonly string[]).includes(domain)) {
        return reply.code(400).send({ error: 'Please use your company email address to register' });
      }

      // Find client by domain mapping
      const client = await fastify.db.client.findFirst({
        where: {
          domainMappings: { has: domain },
          isActive: true,
          allowSelfRegistration: true,
        },
        select: { id: true, name: true, shortCode: true },
      });

      if (!client) {
        return reply.code(400).send({ error: 'No matching organization found for your email domain, or self-registration is not enabled' });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      // Check if person already exists for this client (may be a contact without portal access)
      const existing = await fastify.db.person.findUnique({
        where: { clientId_email: { clientId: client.id, email } },
      });

      let user;
      if (existing) {
        if (existing.hasPortalAccess) {
          return reply.code(409).send({ error: 'An account with this email already exists' });
        }
        // Upgrade existing contact to portal user
        user = await fastify.db.person.update({
          where: { id: existing.id },
          data: { passwordHash, hasPortalAccess: true, userType: 'USER', name: name.trim() },
        });
      } else {
        user = await fastify.db.person.create({
          data: {
            email,
            passwordHash,
            name: name.trim(),
            clientId: client.id,
            userType: 'USER',
            hasPortalAccess: true,
          },
        });
      }

      const userType = (user.userType ?? 'USER') as ClientUserType;
      const accessToken = signPortalAccessToken(fastify.portalJwtSecret, {
        id: user.id,
        email: user.email,
        clientId: user.clientId,
        userType,
        hasOpsAccess: user.hasOpsAccess,
      });
      const refreshToken = await issueRefreshToken(user.id);

      return {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          clientId: user.clientId,
          userType,
          hasOpsAccess: user.hasOpsAccess,
          client,
        },
      };
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

    const user = await fastify.db.person.findUnique({
      where: { id: portalUser.id },
      select: {
        id: true,
        email: true,
        name: true,
        clientId: true,
        userType: true,
        hasPortalAccess: true,
        hasOpsAccess: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        client: { select: { name: true, shortCode: true } },
      },
    });

    if (!user || !user.isActive || !user.hasPortalAccess) {
      return reply.code(401).send({ error: 'User not found or inactive' });
    }

    return user;
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

      const { name, email: rawEmail } = request.body;
      const email = rawEmail?.trim().toLowerCase();
      if (!name && !email) {
        return reply.code(400).send({ error: 'At least one of name or email is required' });
      }

      if (email) {
        const existing = await fastify.db.person.findFirst({
          where: { clientId: portalUser.clientId, email },
        });
        if (existing && existing.id !== portalUser.id) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.person.update({
        where: { id: portalUser.id },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email }),
        },
        select: { id: true, email: true, name: true, clientId: true, userType: true },
      });

      return updated;
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

      const { currentPassword, newPassword } = request.body;
      if (!currentPassword || !newPassword) {
        return reply.code(400).send({ error: 'Current password and new password are required' });
      }

      if (newPassword.length < 8) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }

      const user = await fastify.db.person.findUnique({ where: { id: portalUser.id } });
      if (!user || !user.passwordHash) {
        return reply.code(401).send({ error: 'User not found' });
      }

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: 'Current password is incorrect' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await fastify.db.person.update({
        where: { id: portalUser.id },
        data: { passwordHash },
      });

      return { message: 'Password changed successfully' };
    },
  );
}
