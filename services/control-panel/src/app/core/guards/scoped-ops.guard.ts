import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service.js';
import { isScopedOpsAllowedPath } from './scoped-ops-allowlist.js';

/**
 * Blocks scoped ops users (portal users with ops access) from reaching routes
 * outside their permitted surface. The allowed route list lives in
 * `scoped-ops-allowlist.ts` so the command palette can share the same source
 * of truth. No-op for operators.
 */
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

  if (isScopedOpsAllowedPath(state.url)) {
    return true;
  }
  return fallback;
};
