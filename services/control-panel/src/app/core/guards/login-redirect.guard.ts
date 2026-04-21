import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service.js';

/**
 * Bounce already-authenticated users away from `/login` so they don't see the
 * login form floating inside the fully-rendered shell. Operators land on the
 * dashboard; scoped portal-ops users land on their client detail page.
 */
export const loginRedirectGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = auth.currentUser();
  if (!user) return true;
  if (user.clientId) {
    return router.parseUrl(`/clients/${user.clientId}`);
  }
  return router.parseUrl('/dashboard');
};
