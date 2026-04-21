import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of, tap, map, catchError, shareReplay, finalize, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment.js';

export interface AuthUser {
  personId: string;
  operatorId: string;
  email: string;
  name: string;
  role: string;
  themePreference?: string;
  clientId: string | null;
}

interface OperatorLoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

interface MeResponse {
  personId: string;
  operatorId: string;
  email: string;
  name: string;
  role: string;
  clientId: string | null;
  themePreference?: string;
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

  /** True when the logged-in operator is scoped to a specific client. */
  readonly isScopedOpsUser = computed(() => !!this.currentUser()?.clientId);

  get accessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  login(email: string, password: string): Observable<OperatorLoginResponse> {
    return this.http.post<OperatorLoginResponse>(`${this.baseUrl}/auth/login`, { email, password }).pipe(
      tap(res => this.applyOperatorLogin(res)),
      catchError((err: HttpErrorResponse) => throwError(() => err)),
    );
  }

  logout(): void {
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

    this.refreshInFlight$ = this.http.post<RefreshResponse>(`${this.baseUrl}/auth/refresh`, { refreshToken }).pipe(
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
    return this.http.patch<AuthUser>(`${this.baseUrl}/auth/profile`, data).pipe(
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
    return this.http.post<{ message: string }>(`${this.baseUrl}/auth/change-password`, { currentPassword, newPassword });
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

  private fetchMe(): Observable<AuthUser> {
    return this.http.get<MeResponse>(`${this.baseUrl}/auth/me`).pipe(
      tap(user => {
        this.currentUser.set({
          personId: user.personId,
          operatorId: user.operatorId,
          email: user.email,
          name: user.name,
          role: user.role,
          themePreference: user.themePreference,
          clientId: user.clientId,
        });
      }),
      map(user => ({
        personId: user.personId,
        operatorId: user.operatorId,
        email: user.email,
        name: user.name,
        role: user.role,
        themePreference: user.themePreference,
        clientId: user.clientId,
      })),
    );
  }

  private applyOperatorLogin(res: OperatorLoginResponse): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, res.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
    this.currentUser.set({ ...res.user });
    this.scheduleProactiveRefresh(res.accessToken);
    // Scoped operators land on their own client page; full operators go to dashboard.
    if (res.user.clientId) {
      this.router.navigateByUrl(`/clients/${res.user.clientId}`);
    } else {
      this.router.navigateByUrl('/dashboard');
    }
  }

  private scheduleProactiveRefresh(accessToken: string): void {
    this.clearRefreshTimer();
    try {
      const payload = this.decodeJwtPayload(accessToken);
      const exp = payload?.['exp'];
      if (typeof exp !== 'number') return;
      const expiresAt = exp * 1000;
      const refreshAt = expiresAt - 2 * 60 * 1000;
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

  private decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padLen = (4 - (base64.length % 4)) % 4;
      base64 += '='.repeat(padLen);
      return JSON.parse(atob(base64)) as Record<string, unknown>;
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
