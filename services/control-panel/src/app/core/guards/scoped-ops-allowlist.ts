/**
 * Single source of truth for which routes a scoped ops user is allowed to see.
 *
 * Consumed by:
 * - `scopedOpsGuard` — blocks direct navigation to disallowed routes
 * - `CommandPaletteComponent` — filters the Navigate section
 *
 * Keep the list and the matcher here so both consumers stay in sync when
 * routes are added or removed.
 */

export const SCOPED_ALLOWED_PREFIXES = [
  '/dashboard',   // dashboard is rewritten to client detail in the default redirect
  '/tickets',     // list + detail
  '/profile',
  '/login',
];

/**
 * True if `url` is a route a scoped ops user is allowed to access.
 *
 * - Any `/clients/:id` route is allowed (own client only — the data layer
 *   scopes the response). `/clients` list itself is NOT allowed.
 * - Any route under a prefix in `SCOPED_ALLOWED_PREFIXES` is allowed.
 */
export function isScopedOpsAllowedPath(url: string): boolean {
  if (url === '/clients' || url.startsWith('/clients?')) return false;
  if (url.startsWith('/clients/')) return true;
  return SCOPED_ALLOWED_PREFIXES.some(
    prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`),
  );
}
