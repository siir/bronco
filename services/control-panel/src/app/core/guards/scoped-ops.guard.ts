import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service.js';

/**
 * Routes a scoped ops user (client-side Person with hasOpsAccess) is allowed
 * to visit directly. Anything else is redirected to their own client detail
 * page. This guard is a no-op for operators.
 */
const SCOPED_ALLOWED_PREFIXES = [
  '/dashboard',   // dashboard is rewritten to client detail in the default redirect
  '/tickets',     // list + detail
  '/profile',
  '/login',
];

function isAllowedPath(url: string): boolean {
  // /clients/:id is allowed, but /clients (the list) is not
  if (url === '/clients' || url.startsWith('/clients?')) return false;
  if (url.startsWith('/clients/')) return true;
  return SCOPED_ALLOWED_PREFIXES.some(prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`));
}

export const scopedOpsGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const user = auth.currentUser();
  if (!user || user.isPortalOpsUser !== true) {
    // Not a scoped user — no restrictions.
    return true;
  }

  const clientId = user.clientId;
  const fallback = clientId ? router.parseUrl(`/clients/${clientId}`) : router.parseUrl('/profile');

  if (isAllowedPath(state.url)) {
    return true;
  }
  return fallback;
};
