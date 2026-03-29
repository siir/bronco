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
          };
          return;
        } catch {
          reply.code(401).send({ error: 'Invalid or expired token' });
          return;
        }
      }

      // Control panel / other routes use main JWT secret
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
 * user with one of the specified roles. API-key callers (no user on request)
 * are allowed through since they are trusted service-to-service calls.
 */
export function requireRole(...roles: UserRole[]) {
  return async function (
    request: { user?: AuthUser },
    reply: { code(c: number): { send(o: unknown): void } },
  ) {
    // API-key authenticated requests have no user — allow through
    if (!request.user) return;

    if (!roles.includes(request.user.role)) {
      reply.code(403).send({ error: 'Forbidden: insufficient role' });
    }
  };
}
