import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { map } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.ensureAuthenticated().pipe(
    map(authenticated => authenticated || router.parseUrl('/login')),
  );
};

export const adminGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.ensureAuthenticated().pipe(
    map(authenticated => {
      if (!authenticated) return router.parseUrl('/login');
      if (authService.currentUser()?.userType === 'ADMIN') return true;
      return router.parseUrl('/dashboard');
    }),
  );
};
