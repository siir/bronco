import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of, tap, map, catchError, shareReplay, finalize, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment.js';

export type PortalUserType = 'ADMIN' | 'OPERATOR' | 'USER';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  themePreference?: string;
  /** True when the principal is a client-side Person using a portal JWT with hasOpsAccess. */
  isPortalOpsUser?: boolean;
  /** Set when isPortalOpsUser is true — the Person's client. */
  clientId?: string | null;
  /** Portal user type when isPortalOpsUser is true. */
  portalUserType?: PortalUserType | null;
}

interface OperatorLoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

interface PortalLoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    clientId: string;
    userType: PortalUserType;
    hasOpsAccess: boolean;
    client?: { name: string; shortCode: string } | null;
  };
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

interface MeResponse {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  themePreference?: string;
}

interface PortalMeResponse {
  id: string;
  email: string;
  name: string;
  clientId: string;
  userType: PortalUserType | null;
  hasPortalAccess: boolean;
  hasOpsAccess: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  client?: { name: string; shortCode: string } | null;
}

interface DecodedJwtPayload {
  exp?: number;
  type?: string;
  sub?: string;
  email?: string;
  clientId?: string;
  userType?: PortalUserType;
  hasOpsAccess?: boolean;
  [key: string]: unknown;
}

const ACCESS_TOKEN_KEY = 'rc_access_token';
const REFRESH_TOKEN_KEY = 'rc_refresh_token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private baseUrl = environment.apiUrl;
  private refreshInFlight$: Observable<RefreshResponse> | null = null;
  private refreshTimerHandle: ReturnType<typeof setTimeout> | null = null;

  currentUser = signal<AuthUser | null>(null);

  /** True when the logged-in principal is a client-side Person with ops access. */
  readonly isScopedOpsUser = computed(() => this.currentUser()?.isPortalOpsUser === true);

  get accessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  /**
   * Login: tries operator login first. If the backend returns 401 (invalid
   * credentials for an operator account), falls back to portal login so that
   * a client-side Person with hasOpsAccess can sign in with the same form.
   */
  login(email: string, password: string): Observable<OperatorLoginResponse | PortalLoginResponse> {
    return this.http.post<OperatorLoginResponse>(`${this.baseUrl}/auth/login`, { email, password }).pipe(
      tap(res => this.applyOperatorLogin(res)),
      catchError((err: HttpErrorResponse) => {
        // Fall through to portal login when:
        //   - OPERATOR_NOT_FOUND: email doesn't exist as an operator (or account is inactive)
        //   - 403: operator exists and password is correct, but role is CLIENT — the account
        //     is a portal user and should authenticate via the portal auth endpoint instead.
        // If the operator exists but the password is wrong (401 without code), surface the error.
        const body = err.error as Record<string, unknown> | null;
        if (body?.['code'] === 'OPERATOR_NOT_FOUND' || err.status === 403) {
          return this.http.post<PortalLoginResponse>(`${this.baseUrl}/portal/auth/login`, { email, password }).pipe(
            tap(res => this.applyPortalLogin(res)),
          );
        }
        return throwError(() => err);
      }),
    );
  }

  logout(): void {
    // Best-effort server-side revocation — don't block on failure
    const token = this.accessToken;
    if (token) {
      this.http.post(`${this.baseUrl}/auth/logout`, {}).subscribe();
    }
    this.clearSession();
    this.router.navigateByUrl('/login');
  }

  refreshTokens(): Observable<RefreshResponse> {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      this.clearSession();
      return throwError(() => new Error('No refresh token'));
    }

    if (this.refreshInFlight$) {
      return this.refreshInFlight$;
    }

    // Pick refresh endpoint based on stored access token shape
    const isPortal = this.isPortalToken(this.accessToken);
    const refreshUrl = isPortal ? `${this.baseUrl}/portal/auth/refresh` : `${this.baseUrl}/auth/refresh`;

    this.refreshInFlight$ = this.http.post<RefreshResponse>(refreshUrl, { refreshToken }).pipe(
      tap(res => {
        localStorage.setItem(ACCESS_TOKEN_KEY, res.accessToken);
        localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
        this.scheduleProactiveRefresh(res.accessToken);
      }),
      shareReplay(1),
      finalize(() => {
        this.refreshInFlight$ = null;
      }),
    );

    return this.refreshInFlight$;
  }

  ensureAuthenticated(): Observable<boolean> {
    if (this.currentUser()) {
      return of(true);
    }

    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
      return of(false);
    }

    return this.refreshTokens().pipe(
      switchMap(() => this.fetchMe()),
      map(() => true),
      catchError(() => of(false)),
    );
  }

  updateProfile(data: { name?: string; email?: string }): Observable<AuthUser> {
    const isPortal = this.currentUser()?.isPortalOpsUser === true;
    const url = isPortal ? `${this.baseUrl}/portal/auth/profile` : `${this.baseUrl}/auth/profile`;
    const method$ = isPortal
      ? this.http.patch<Partial<AuthUser>>(url, data)
      : this.http.patch<AuthUser>(url, data);
    return method$.pipe(
      tap(user => {
        const existing = this.currentUser();
        if (existing) {
          this.currentUser.set({ ...existing, ...user } as AuthUser);
        }
      }),
      map(user => {
        const existing = this.currentUser();
        return (existing ?? (user as AuthUser)) as AuthUser;
      }),
    );
  }

  changePassword(currentPassword: string, newPassword: string): Observable<{ message: string }> {
    const isPortal = this.currentUser()?.isPortalOpsUser === true;
    const url = isPortal
      ? `${this.baseUrl}/portal/auth/change-password`
      : `${this.baseUrl}/auth/change-password`;
    return this.http.post<{ message: string }>(url, { currentPassword, newPassword });
  }

  initialize(): Observable<void> {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!token) return of(undefined);

    return this.fetchMe().pipe(
      tap(() => this.scheduleProactiveRefresh(token)),
      map(() => undefined),
      catchError(() => {
        localStorage.removeItem(ACCESS_TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        return of(undefined);
      }),
    );
  }

  /**
   * Fetches the current user via the appropriate /me endpoint based on the
   * stored access token shape. Used on app init and after refresh.
   */
  private fetchMe(): Observable<AuthUser> {
    const token = this.accessToken;
    if (token && this.isPortalToken(token)) {
      return this.http.get<PortalMeResponse>(`${this.baseUrl}/portal/auth/me`).pipe(
        tap(me => {
          this.currentUser.set({
            id: me.id,
            email: me.email,
            name: me.name,
            role: 'CLIENT',
            isPortalOpsUser: me.hasOpsAccess === true,
            clientId: me.clientId,
            portalUserType: (me.userType ?? null) as PortalUserType | null,
          });
        }),
        map(me => this.currentUser() ?? {
          id: me.id,
          email: me.email,
          name: me.name,
          role: 'CLIENT',
          isPortalOpsUser: me.hasOpsAccess === true,
          clientId: me.clientId,
          portalUserType: (me.userType ?? null) as PortalUserType | null,
        }),
      );
    }
    return this.http.get<MeResponse>(`${this.baseUrl}/auth/me`).pipe(
      tap(user => {
        this.currentUser.set({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          themePreference: user.themePreference,
          isPortalOpsUser: false,
          clientId: null,
          portalUserType: null,
        });
      }),
      map(user => ({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        themePreference: user.themePreference,
        isPortalOpsUser: false,
        clientId: null,
        portalUserType: null,
      })),
    );
  }

  private applyOperatorLogin(res: OperatorLoginResponse): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, res.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
    this.currentUser.set({
      ...res.user,
      isPortalOpsUser: false,
      clientId: null,
      portalUserType: null,
    });
    this.scheduleProactiveRefresh(res.accessToken);
    this.router.navigateByUrl('/dashboard');
  }

  private applyPortalLogin(res: PortalLoginResponse): void {
    // Reject portal logins without ops access — the control panel is only
    // accessible to ops-access people.
    if (!res.user.hasOpsAccess) {
      throw new HttpErrorResponse({
        status: 403,
        statusText: 'Forbidden',
        error: { error: 'This account does not have control panel access' },
      });
    }
    localStorage.setItem(ACCESS_TOKEN_KEY, res.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
    this.currentUser.set({
      id: res.user.id,
      email: res.user.email,
      name: res.user.name,
      role: 'CLIENT',
      isPortalOpsUser: true,
      clientId: res.user.clientId,
      portalUserType: res.user.userType,
    });
    this.scheduleProactiveRefresh(res.accessToken);
    // Route scoped users to their own client detail page
    this.router.navigateByUrl(`/clients/${res.user.clientId}`);
  }

  private scheduleProactiveRefresh(accessToken: string): void {
    this.clearRefreshTimer();
    try {
      const payload = this.decodeJwtPayload(accessToken);
      if (!payload?.exp) return;
      const expiresAt = payload.exp * 1000;
      const refreshAt = expiresAt - 2 * 60 * 1000; // 2 minutes before expiry
      const delay = refreshAt - Date.now();
      if (delay > 0) {
        this.refreshTimerHandle = setTimeout(() => {
          this.refreshTokens().subscribe({
            error: () => {
              // Proactive refresh failed — will retry on next 401
            },
          });
        }, delay);
      }
    } catch {
      // Token decode failed — skip proactive refresh
    }
  }

  private isPortalToken(token: string | null): boolean {
    if (!token) return false;
    const payload = this.decodeJwtPayload(token);
    return payload?.type === 'portal_access';
  }

  private decodeJwtPayload(token: string): DecodedJwtPayload | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      // Normalize base64url to base64: replace - with +, _ with /
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      // Pad to multiple of 4
      const padLen = (4 - (base64.length % 4)) % 4;
      base64 += '='.repeat(padLen);
      return JSON.parse(atob(base64)) as DecodedJwtPayload;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    this.refreshInFlight$ = null;
    this.clearRefreshTimer();
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    this.currentUser.set(null);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimerHandle !== null) {
      clearTimeout(this.refreshTimerHandle);
      this.refreshTimerHandle = null;
    }
  }
}
