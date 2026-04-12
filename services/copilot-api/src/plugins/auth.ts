import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import type { UserRole, ClientUserType } from '@bronco/shared-types';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  type: 'access';
}

export interface PortalJwtPayload {
  sub: string;
  email: string;
  clientId: string;
  userType: ClientUserType;
  hasOpsAccess: boolean;
  type: 'portal_access';
}

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface PortalUser {
  id: string;
  email: string;
  clientId: string;
  userType: ClientUserType;
  hasOpsAccess: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    portalUser?: PortalUser;
  }
  interface FastifyInstance {
    jwtSecret: string;
    portalJwtSecret: string;
  }
}

/** Routes that bypass authentication entirely */
const PUBLIC_ROUTES = ['/api/health', '/api/auth/login', '/api/auth/refresh', '/api/portal/auth/login', '/api/portal/auth/refresh', '/api/portal/auth/register'];

interface AuthPluginOpts {
  apiKey: string;
  jwtSecret: string;
  portalJwtSecret: string;
}

export const authPlugin = fp(async (fastify, opts: AuthPluginOpts) => {
  fastify.decorate('jwtSecret', opts.jwtSecret);
  fastify.decorate('portalJwtSecret', opts.portalJwtSecret);

  fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth for public routes
    if (PUBLIC_ROUTES.some((r) => request.url.startsWith(r))) return;

    // 1) API key auth (service-to-service, workers)
    const apiKey = request.headers['x-api-key'];
    if (apiKey === opts.apiKey) return;

    // 2) JWT Bearer auth
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Portal routes use portal JWT secret
      if (request.url.startsWith('/api/portal/')) {
        try {
          const payload = jwt.verify(token, opts.portalJwtSecret) as PortalJwtPayload;
          if (payload.type !== 'portal_access') {
            reply.code(401).send({ error: 'Invalid token type' });
            return;
          }
          request.portalUser = {
            id: payload.sub,
            email: payload.email,
            clientId: payload.clientId,
            userType: payload.userType,
            hasOpsAccess: payload.hasOpsAccess ?? false,
          };
          return;
        } catch {
          reply.code(401).send({ error: 'Invalid or expired token' });
          return;
        }
      }

      // Control panel / other routes:
      // Try portal JWT first — Persons with hasOpsAccess can use the control panel.
      try {
        const payload = jwt.verify(token, opts.portalJwtSecret) as PortalJwtPayload;
        if (payload.type === 'portal_access' && payload.hasOpsAccess) {
          request.portalUser = {
            id: payload.sub,
            email: payload.email,
            clientId: payload.clientId,
            userType: payload.userType,
            hasOpsAccess: true,
          };
          return;
        }
      } catch {
        // Not a portal token — fall through to main JWT
      }

      // Main JWT secret (Operator)
      try {
        const payload = jwt.verify(token, opts.jwtSecret) as JwtPayload;
        if (payload.type !== 'access') {
          reply.code(401).send({ error: 'Invalid token type' });
          return;
        }
        request.user = {
          id: payload.sub,
          email: payload.email,
          role: payload.role,
        };
        return;
      } catch {
        reply.code(401).send({ error: 'Invalid or expired token' });
        return;
      }
    }

    reply.code(401).send({ error: 'Unauthorized' });
  });
});

/**
 * Route-level preHandler hook that requires the caller to be an authenticated
 * operator (main JWT) with one of the specified roles. API-key callers (no
 * user AND no portalUser on the request) are allowed through since they are
 * trusted service-to-service calls.
 *
 * Portal users authenticated via a portal JWT are REJECTED — they must use
 * routes guarded by `requireOpsAccess()` instead.
 */
export function requireRole(...roles: UserRole[]) {
  return async function (
    request: { user?: AuthUser; portalUser?: PortalUser },
    reply: { code(c: number): { send(o: unknown): void } },
  ) {
    // Portal user on a non-portal route — block even if hasOpsAccess.
    // They must use routes that explicitly opt in via requireOpsAccess().
    if (!request.user && request.portalUser) {
      reply.code(403).send({ error: 'Forbidden: this route requires operator authentication' });
      return;
    }

    // API-key authenticated requests have no user — allow through
    if (!request.user) return;

    if (!roles.includes(request.user.role)) {
      reply.code(403).send({ error: 'Forbidden: insufficient role' });
    }
  };
}

/**
 * Route-level preHandler hook that allows either:
 *  1. An authenticated operator (main JWT) with one of the specified roles, OR
 *  2. A portal user with `hasOpsAccess === true`.
 *
 * Use this on routes that should be accessible to client-side ops people
 * (e.g. clients, tickets, people) in addition to platform operators.
 * Routes that should NOT be accessible to ops-access people (settings,
 * system-status, operators, etc.) should use `requireRole()` instead.
 */
export function requireOpsAccess(...operatorRoles: UserRole[]) {
  return async function (
    request: { user?: AuthUser; portalUser?: PortalUser },
    reply: { code(c: number): { send(o: unknown): void } },
  ) {
    // Operator with an acceptable role — allow
    if (request.user) {
      if (operatorRoles.length === 0 || operatorRoles.includes(request.user.role)) return;
      reply.code(403).send({ error: 'Forbidden: insufficient role' });
      return;
    }

    // Portal user with ops access — allow
    if (request.portalUser?.hasOpsAccess) return;

    // API-key (service-to-service) — allow
    if (!request.portalUser) return;

    // Portal user without ops access — reject
    reply.code(403).send({ error: 'Forbidden: ops access required' });
  };
}
