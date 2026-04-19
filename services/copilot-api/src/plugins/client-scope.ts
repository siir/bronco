import type { FastifyRequest } from 'fastify';
import { OperatorRole } from '@bronco/shared-types';

export type ClientScope =
  | { type: 'all' }
  | { type: 'assigned'; clientIds: string[] }
  | { type: 'single'; clientId: string };

/**
 * Resolve which clients the current caller can access.
 *
 * - Operator with `clientId === null` and `role === ADMIN` → all clients.
 * - Operator with `clientId === null` and `role === STANDARD` → OperatorClient-assigned list.
 * - Operator with `clientId !== null` → single-client scope (client-scoped operator).
 * - Portal user → single-client scope (their own client).
 * - API-key (no user, no portal user) → full access.
 */
export async function resolveClientScope(request: FastifyRequest): Promise<ClientScope> {
  if (request.user) {
    if (request.user.clientId) {
      return { type: 'single', clientId: request.user.clientId };
    }
    if (request.user.role === OperatorRole.ADMIN) {
      return { type: 'all' };
    }
    const rows = await request.server.db.operatorClient.findMany({
      where: { operatorId: request.user.operatorId },
      select: { clientId: true },
    });
    return { type: 'assigned', clientIds: rows.map((r) => r.clientId) };
  }

  if (request.portalUser) {
    return { type: 'single', clientId: request.portalUser.clientId };
  }

  return { type: 'all' };
}

/**
 * Convert a ClientScope to a Prisma where clause fragment for clientId filtering.
 */
export function scopeToWhere(scope: ClientScope): { clientId?: string | { in: string[] } } {
  if (scope.type === 'all') return {};
  if (scope.type === 'assigned') return { clientId: { in: scope.clientIds } };
  return { clientId: scope.clientId };
}
