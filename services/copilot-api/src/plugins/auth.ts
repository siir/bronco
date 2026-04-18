import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import type {
  OperatorJwtPayload,
  OperatorRole,
  PortalJwtPayload,
  ClientUserType,
} from '@bronco/shared-types';

// Re-export JWT payload types for callers that previously imported from this file.
export type { OperatorJwtPayload as JwtPayload } from '@bronco/shared-types';
export type { PortalJwtPayload } from '@bronco/shared-types';

/**
 * Request-scoped operator identity. `sub`/`personId` is the unified Person ID;
 * `operatorId` is the extension record. Platform operators have `clientId: null`;
 * client-scoped operators carry their clientId here (same semantics as the
 * legacy `User.clientId`).
 */
export interface AuthUser {
  personId: string;
  operatorId: string;
  email: string;
  role: OperatorRole;
  clientId: string | null;
}

/**
 * Request-scoped portal (client-user) identity. Portal users have no
 * control-panel access — operator surfaces must use `AuthUser`.
 */
export interface PortalUser {
  personId: string;
  clientUserId: string;
  email: string;
  name: string;
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
const PUBLIC_ROUTES = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/portal/auth/login',
  '/api/portal/auth/refresh',
  '/api/portal/auth/register',
];

interface AuthPluginOpts {
  apiKey: string;
  jwtSecret: string;
  portalJwtSecret: string;
}

export const authPlugin = fp(async (fastify, opts: AuthPluginOpts) => {
  fastify.decorate('jwtSecret', opts.jwtSecret);
  fastify.decorate('portalJwtSecret', opts.portalJwtSecret);

  fastify.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_ROUTES.some((r) => request.url.startsWith(r))) return;

    // API key auth (service-to-service)
    const apiKey = request.headers['x-api-key'];
    if (apiKey === opts.apiKey) return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    const token = authHeader.slice(7);

    // Portal routes verify against the portal secret.
    if (request.url.startsWith('/api/portal/')) {
      try {
        const payload = jwt.verify(token, opts.portalJwtSecret) as PortalJwtPayload;
        if (payload.type !== 'portal_access') {
          reply.code(401).send({ error: 'Invalid token type' });
          return;
        }
        request.portalUser = {
          personId: payload.sub,
          clientUserId: payload.clientUserId,
          email: payload.email,
          name: payload.name,
          clientId: payload.clientId,
          userType: payload.userType,
        };
      } catch {
        reply.code(401).send({ error: 'Invalid or expired token' });
      }
      return;
    }

    // Everything else is an operator route.
    try {
      const payload = jwt.verify(token, opts.jwtSecret) as OperatorJwtPayload;
      if (payload.type !== 'access') {
        reply.code(401).send({ error: 'Invalid token type' });
        return;
      }
      request.user = {
        personId: payload.sub,
        operatorId: payload.operatorId,
        email: payload.email,
        role: payload.role,
        clientId: payload.clientId ?? null,
      };
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });
});

/**
 * Route-level preHandler hook requiring the caller to be an authenticated
 * operator with one of the specified roles. API-key callers (no user AND no
 * portalUser) are allowed through as trusted service-to-service calls.
 * Portal users are rejected — they never have control-panel access.
 */
export function requireRole(...roles: OperatorRole[]) {
  return async function (
    request: { user?: AuthUser; portalUser?: PortalUser },
    reply: { code(c: number): { send(o: unknown): void } },
  ) {
    if (!request.user && request.portalUser) {
      reply.code(403).send({ error: 'Forbidden: this route requires operator authentication' });
      return;
    }

    // API-key authenticated requests have no user — allow through.
    if (!request.user) return;

    if (roles.length === 0) return;
    if (!roles.includes(request.user.role)) {
      reply.code(403).send({ error: 'Forbidden: insufficient role' });
    }
  };
}
