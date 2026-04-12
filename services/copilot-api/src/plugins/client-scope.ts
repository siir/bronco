import type { FastifyRequest } from 'fastify';

export type ClientScope =
  | { type: 'all' }
  | { type: 'assigned'; clientIds: string[] }
  | { type: 'single'; clientId: string };

/**
 * Resolve which clients the current caller can access.
 *
 * - Platform admin (User with role === 'ADMIN') → all clients
 * - Scoped operator (User with role === 'OPERATOR') → assigned clients via OperatorClient
 * - Person with hasOpsAccess or portal user → their own client
 *
 * The optional `getOperatorClientIds` resolver looks up assigned clients for a
 * scoped operator. If omitted, scoped operators fall back to "all clients" so
 * routes that don't yet support scoping continue to work.
 */
export async function resolveClientScope(
  request: FastifyRequest,
  getOperatorClientIds?: (operatorId: string) => Promise<string[]>,
): Promise<ClientScope> {
  // Operator (control panel user)
  if (request.user) {
    if (request.user.role === 'ADMIN') return { type: 'all' };

    // Scoped operator — look up assigned clients
    if (getOperatorClientIds) {
      const clientIds = await getOperatorClientIds(request.user.id);
      return { type: 'assigned', clientIds };
    }
    // No resolver provided — fall back to full access
    return { type: 'all' };
  }

  // Person with ops access OR portal user — single-client scope
  if (request.portalUser) {
    return { type: 'single', clientId: request.portalUser.clientId };
  }

  // API-key authenticated requests have neither user nor portalUser.
  // They are trusted service-to-service callers with full access.
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
