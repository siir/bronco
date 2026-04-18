import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@bronco/db';
import { OperatorRole } from '@bronco/shared-types';

/**
 * Look up the list of client IDs assigned to a scoped operator. Centralised
 * here so it isn't duplicated across every route file that calls resolveClientScope.
 */
export async function getOperatorClientIds(db: PrismaClient, operatorId: string): Promise<string[]> {
  const rows = await db.operatorClient.findMany({
    where: { operatorId },
    select: { clientId: true },
  });
  return rows.map((r) => r.clientId);
}

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
 *
 * `getOperatorClientIds` is kept as an optional second argument to minimise
 * churn across callers in Wave 1. TODO(#219 Wave 2A): drop the second arg and
 * resolve the mapping internally against the Prisma client.
 */
export async function resolveClientScope(
  request: FastifyRequest,
  getOperatorClientIds?: (operatorId: string) => Promise<string[]>,
): Promise<ClientScope> {
  if (request.user) {
    if (request.user.clientId) {
      return { type: 'single', clientId: request.user.clientId };
    }
    if (request.user.role === OperatorRole.ADMIN) {
      return { type: 'all' };
    }
    if (getOperatorClientIds) {
      const clientIds = await getOperatorClientIds(request.user.operatorId);
      return { type: 'assigned', clientIds };
    }
    return { type: 'all' };
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
