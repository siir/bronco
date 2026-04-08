import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { CONTROL_PANEL_ROLES, type UserRole } from '@bronco/shared-types';
import type { AuthUser } from '../plugins/auth.js';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function signAccessToken(secret: string, user: { id: string; email: string; role: UserRole }): string {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, type: 'access' }, secret, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

function signRefreshToken(secret: string, userId: string, jti: string): string {
  return jwt.sign({ sub: userId, jti, type: 'refresh' }, secret, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Issue a new refresh token, persisting it in the DB for revocation tracking.
   */
  async function issueRefreshToken(userId: string): Promise<string> {
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    await fastify.db.refreshToken.create({
      data: { jti, userId, expiresAt },
    });

    return signRefreshToken(fastify.jwtSecret, userId, jti);
  }

  /**
   * POST /api/auth/login
   * Body: { email, password }
   * Returns access + refresh tokens.
   * CLIENT-role users are rejected — they cannot access the control panel.
   */
  fastify.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    async (request, reply) => {
      const { email, password } = request.body;

      if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
      }

      const user = await fastify.db.user.findUnique({ where: { email: email.toLowerCase() } });

      if (!user || !user.isActive) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }

      // CLIENT accounts cannot log in to the control panel
      const role = user.role as UserRole;
      if (!CONTROL_PANEL_ROLES.includes(role)) {
        return reply.code(403).send({ error: 'Access denied: insufficient permissions' });
      }

      // Update last login timestamp
      await fastify.db.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const accessToken = signAccessToken(fastify.jwtSecret, { ...user, role });
      const refreshToken = await issueRefreshToken(user.id);

      return {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          themePreference: user.themePreference,
        },
      };
    },
  );

  /**
   * POST /api/auth/refresh
   * Body: { refreshToken }
   * Returns a new access token and a new refresh token.
   * The old refresh token is revoked (single-use rotation).
   */
  fastify.post<{ Body: { refreshToken: string } }>(
    '/api/auth/refresh',
    async (request, reply) => {
      const { refreshToken } = request.body;

      if (!refreshToken) {
        return reply.code(400).send({ error: 'Refresh token is required' });
      }

      let payload: { sub: string; jti?: string; type?: string };
      try {
        payload = jwt.verify(refreshToken, fastify.jwtSecret) as { sub: string; jti?: string; type?: string };
      } catch {
        return reply.code(401).send({ error: 'Invalid or expired refresh token' });
      }

      if (payload.type !== 'refresh') {
        return reply.code(401).send({ error: 'Invalid token type' });
      }

      // If the token has a jti, atomically revoke it (single-use rotation).
      // updateMany with revokedAt: null prevents race conditions where two
      // concurrent refresh calls both succeed with the same token.
      if (payload.jti) {
        const result = await fastify.db.refreshToken.updateMany({
          where: { jti: payload.jti, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        if (result.count === 0) {
          return reply.code(401).send({ error: 'Refresh token has been revoked' });
        }
      }

      const user = await fastify.db.user.findUnique({ where: { id: payload.sub } });

      if (!user || !user.isActive) {
        return reply.code(401).send({ error: 'User not found or inactive' });
      }

      const role = user.role as UserRole;
      if (!CONTROL_PANEL_ROLES.includes(role)) {
        return reply.code(403).send({ error: 'Access denied: insufficient permissions' });
      }

      const newAccessToken = signAccessToken(fastify.jwtSecret, { ...user, role });
      const newRefreshToken = await issueRefreshToken(user.id);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    },
  );

  /**
   * POST /api/auth/logout
   * Revokes all refresh tokens for the authenticated user.
   */
  fastify.post('/api/auth/logout', async (request, reply) => {
    const authUser = request.user as AuthUser | undefined;
    if (!authUser) {
      return reply.code(401).send({ error: 'JWT authentication required' });
    }

    await fastify.db.refreshToken.updateMany({
      where: { userId: authUser.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'All sessions revoked' };
  });

  /**
   * GET /api/auth/me
   * Returns the authenticated user's profile.
   * Requires a valid JWT (not API key).
   */
  fastify.get('/api/auth/me', async (request, reply) => {
    const authUser = request.user as AuthUser | undefined;
    if (!authUser) {
      return reply.code(401).send({ error: 'JWT authentication required' });
    }

    const user = await fastify.db.user.findUnique({
      where: { id: authUser.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
        themePreference: true,
      },
    });

    if (!user || !user.isActive) {
      return reply.code(401).send({ error: 'User not found or inactive' });
    }

    return user;
  });

  /**
   * PATCH /api/auth/profile
   * Body: { name?, email? }
   * Updates the authenticated user's profile.
   */
  fastify.patch<{ Body: { name?: string; email?: string } }>(
    '/api/auth/profile',
    async (request, reply) => {
      const authUser = request.user as AuthUser | undefined;
      if (!authUser) {
        return reply.code(401).send({ error: 'JWT authentication required' });
      }

      const { name, email: rawEmail } = request.body;
      const email = rawEmail?.trim();
      if (!name && !email) {
        return reply.code(400).send({ error: 'At least one of name or email is required' });
      }

      // If changing email, check for uniqueness
      if (email) {
        const existing = await fastify.db.user.findUnique({ where: { email: email.toLowerCase() } });
        if (existing && existing.id !== authUser.id) {
          return reply.code(409).send({ error: 'Email is already in use' });
        }
      }

      const updated = await fastify.db.user.update({
        where: { id: authUser.id },
        data: {
          ...(name && { name: name.trim() }),
          ...(email && { email: email.toLowerCase() }),
        },
        select: { id: true, email: true, name: true, role: true, themePreference: true },
      });

      return updated;
    },
  );

  /**
   * PATCH /api/auth/me/theme
   * Body: { themePreference: string }
   * Updates the current user's theme preference.
   */
  const VALID_THEMES = ['apple', 'linear', 'nvidia', 'sentry', 'supabase', 'vercel'];

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

      const updated = await fastify.db.user.update({
        where: { id: authUser.id },
        data: { themePreference },
        select: { themePreference: true },
      });

      return { themePreference: updated.themePreference };
    },
  );

  /**
   * POST /api/auth/change-password
   * Body: { currentPassword, newPassword }
   * Changes the authenticated user's password.
   */
  fastify.post<{ Body: { currentPassword: string; newPassword: string } }>(
    '/api/auth/change-password',
    async (request, reply) => {
      const authUser = request.user as AuthUser | undefined;
      if (!authUser) {
        return reply.code(401).send({ error: 'JWT authentication required' });
      }

      const { currentPassword, newPassword } = request.body;
      if (!currentPassword || !newPassword) {
        return reply.code(400).send({ error: 'Current password and new password are required' });
      }

      if (newPassword.length < 8) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }

      const user = await fastify.db.user.findUnique({ where: { id: authUser.id } });
      if (!user) {
        return reply.code(401).send({ error: 'User not found' });
      }

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: 'Current password is incorrect' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await fastify.db.user.update({
        where: { id: authUser.id },
        data: { passwordHash },
      });

      return { message: 'Password changed successfully' };
    },
  );
}
