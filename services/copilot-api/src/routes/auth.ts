import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  AccessType,
  CONTROL_PANEL_ROLES,
  type AuthLoginResponse,
  type AuthMeResponse,
  type OperatorJwtPayload,
  type OperatorRefreshPayload,
} from '@bronco/shared-types';
import type { AuthUser } from '../plugins/auth.js';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const VALID_THEMES = ['apple', 'linear', 'nvidia', 'sentry', 'supabase', 'vercel'];

function signAccessToken(secret: string, payload: OperatorJwtPayload): string {
  return jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

function signRefreshToken(secret: string, personId: string, jti: string): string {
  const payload: OperatorRefreshPayload = { sub: personId, jti, type: 'refresh' };
  return jwt.sign(payload, secret, { expiresIn: REFRESH_TOKEN_EXPIRY });
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  async function issueRefreshToken(personId: string): Promise<string> {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await fastify.db.personRefreshToken.create({
      data: { jti, personId, accessType: AccessType.OPERATOR, expiresAt },
    });

    return signRefreshToken(fastify.jwtSecret, personId, jti);
  }

  async function buildAuthMe(personId: string): Promise<AuthMeResponse | null> {
    // Explicit select — `buildAuthMe` powers GET /api/auth/me and ships its
    // return value to the caller. Never pull `passwordHash` or `emailLower`
    // into scope here.
    const person = await fastify.db.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        operator: true,
      },
    });
    if (!person || !person.isActive || !person.operator) return null;
    const op = person.operator;
    return {
      personId: person.id,
      operatorId: op.id,
      email: person.email,
      name: person.name,
      role: op.role,
      clientId: op.clientId ?? null,
      themePreference: op.themePreference,
    };
  }

  /**
   * POST /api/auth/login
   */
  fastify.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    async (request, reply) => {
      const { email, password } = request.body ?? {};
      if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
      }

      const emailLower = email.trim().toLowerCase();
      // Explicit select — pull only the fields needed: passwordHash for
      // bcrypt.compare and operator fields for session construction.
      // emailLower is never returned to the caller.
      const person = await fastify.db.person.findUnique({
        where: { emailLower },
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          passwordHash: true,
          operator: true,
        },
      });

      if (!person || !person.isActive || !person.passwordHash) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      if (!person.operator) {
        return reply.code(401).send({ error: 'Invalid email or password', code: 'OPERATOR_NOT_FOUND' });
      }

      const valid = await bcrypt.compare(password, person.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      if (!CONTROL_PANEL_ROLES.includes(person.operator.role)) {
        return reply.code(403).send({ error: 'Access denied: insufficient permissions' });
      }

      await fastify.db.operator.update({
        where: { id: person.operator.id },
        data: { lastLoginAt: new Date() },
      });

      const me: AuthMeResponse = {
        personId: person.id,
        operatorId: person.operator.id,
        email: person.email,
        name: person.name,
        role: person.operator.role,
        clientId: person.operator.clientId ?? null,
        themePreference: person.operator.themePreference,
      };

      const accessToken = signAccessToken(fastify.jwtSecret, {
        sub: me.personId,
        operatorId: me.operatorId,
        email: me.email,
        role: me.role,
        clientId: me.clientId,
        type: 'access',
      });
      const refreshToken = await issueRefreshToken(person.id);

      const response: AuthLoginResponse = { accessToken, refreshToken, user: me };
      return response;
    },
  );

  /**
   * POST /api/auth/refresh
   */
  fastify.post<{ Body: { refreshToken: string } }>(
    '/api/auth/refresh',
    async (request, reply) => {
      const { refreshToken } = request.body ?? {};
      if (!refreshToken) {
        return reply.code(400).send({ error: 'Refresh token is required' });
      }

      let payload: OperatorRefreshPayload;
      try {
        payload = jwt.verify(refreshToken, fastify.jwtSecret) as OperatorRefreshPayload;
      } catch {
        return reply.code(401).send({ error: 'Invalid or expired refresh token' });
      }

      if (payload.type !== 'refresh') {
        return reply.code(401).send({ error: 'Invalid token type' });
      }

      if (payload.jti) {
        const result = await fastify.db.personRefreshToken.updateMany({
          where: { jti: payload.jti, accessType: AccessType.OPERATOR, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (result.count === 0) {
          return reply.code(401).send({ error: 'Refresh token has been revoked' });
        }
      }

      const me = await buildAuthMe(payload.sub);
      if (!me) {
        return reply.code(401).send({ error: 'User not found or inactive' });
      }
      if (!CONTROL_PANEL_ROLES.includes(me.role)) {
        return reply.code(403).send({ error: 'Access denied: insufficient permissions' });
      }

      const newAccessToken = signAccessToken(fastify.jwtSecret, {
        sub: me.personId,
        operatorId: me.operatorId,
        email: me.email,
        role: me.role,
        clientId: me.clientId,
        type: 'access',
      });
      const newRefreshToken = await issueRefreshToken(me.personId);

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    },
  );

  /**
   * POST /api/auth/logout
   */
  fastify.post('/api/auth/logout', async (request, reply) => {
    const authUser = request.user as AuthUser | undefined;
    if (!authUser) {
      return reply.code(401).send({ error: 'JWT authentication required' });
    }

    await fastify.db.personRefreshToken.updateMany({
      where: { personId: authUser.personId, accessType: AccessType.OPERATOR, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'All sessions revoked' };
  });

  /**
   * GET /api/auth/me
   */
  fastify.get('/api/auth/me', async (request, reply) => {
    const authUser = request.user as AuthUser | undefined;
    if (!authUser) {
      return reply.code(401).send({ error: 'JWT authentication required' });
    }

    const me = await buildAuthMe(authUser.personId);
    if (!me) {
      return reply.code(401).send({ error: 'User not found or inactive' });
    }
    return me;
  });

  /**
   * PATCH /api/auth/profile
   */
  fastify.patch<{ Body: { name?: string; email?: string } }>(
    '/api/auth/profile',
    async (request, reply) => {
      const authUser = request.user as AuthUser | undefined;
      if (!authUser) {
        return reply.code(401).send({ error: 'JWT authentication required' });
      }

      const { name, email: rawEmail } = request.body ?? {};
      const email = rawEmail?.trim();
      if (!name && !email) {
        return reply.code(400).send({ error: 'At least one of name or email is required' });
      }

      const emailLower = email?.toLowerCase();
      if (emailLower) {
        // Only need the id for the conflict check — don't pull the hash.
        const existing = await fastify.db.person.findUnique({
          where: { emailLower },
          select: { id: true },
        });
        if (existing && existing.id !== authUser.personId) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.person.update({
        where: { id: authUser.personId },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email, emailLower: email.toLowerCase() }),
        },
        // Explicit select — this row is mapped directly into the response;
        // keep passwordHash/emailLower out of scope.
        select: {
          id: true,
          email: true,
          name: true,
          operator: true,
        },
      });

      return {
        personId: updated.id,
        operatorId: updated.operator?.id ?? authUser.operatorId,
        email: updated.email,
        name: updated.name,
        role: updated.operator?.role ?? authUser.role,
        clientId: updated.operator?.clientId ?? authUser.clientId,
        themePreference: updated.operator?.themePreference ?? 'apple',
      } satisfies AuthMeResponse;
    },
  );

  /**
   * PATCH /api/auth/me/theme
   */
  fastify.patch<{ Body: { themePreference: string } }>(
    '/api/auth/me/theme',
    async (request, reply) => {
      const authUser = request.user as AuthUser | undefined;
      if (!authUser) {
        return reply.code(401).send({ error: 'JWT authentication required' });
      }

      const { themePreference } = request.body ?? {};
      if (!themePreference || !VALID_THEMES.includes(themePreference)) {
        return reply.code(400).send({
          error: `Invalid theme. Must be one of: ${VALID_THEMES.join(', ')}`,
        });
      }

      const updated = await fastify.db.operator.update({
        where: { id: authUser.operatorId },
        data: { themePreference },
        select: { themePreference: true },
      });

      return { themePreference: updated.themePreference };
    },
  );

  /**
   * POST /api/auth/change-password
   */
  fastify.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/change-password',
    async (request, reply) => {
      const authUser = request.user as AuthUser | undefined;
      if (!authUser) {
        return reply.code(401).send({ error: 'JWT authentication required' });
      }

      const { currentPassword, newPassword } = request.body ?? {};
      if (!currentPassword || !newPassword) {
        return reply.code(400).send({ error: 'Current password and new password are required' });
      }
      if (newPassword.length < 8) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }

      // Explicit select — only passwordHash is needed here; never pull the
      // full Person row for a credential-check-only path.
      const person = await fastify.db.person.findUnique({
        where: { id: authUser.personId },
        select: { passwordHash: true },
      });
      if (!person || !person.passwordHash) {
        return reply.code(401).send({ error: 'User not found' });
      }

      const valid = await bcrypt.compare(currentPassword, person.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: 'Current password is incorrect' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await fastify.db.person.update({
        where: { id: authUser.personId },
        data: { passwordHash },
      });

      return { message: 'Password changed successfully' };
    },
  );
}
