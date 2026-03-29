import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of, tap, map, catchError, shareReplay, finalize, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
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

  get accessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  login(email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.baseUrl}/auth/login`, { email, password }).pipe(
      tap(res => {
        localStorage.setItem(ACCESS_TOKEN_KEY, res.accessToken);
        localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
        this.currentUser.set(res.user);
        this.scheduleProactiveRefresh(res.accessToken);
        this.router.navigateByUrl('/dashboard');
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
      switchMap(() => this.http.get<MeResponse>(`${this.baseUrl}/auth/me`)),
      tap(user => {
        this.currentUser.set({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        });
      }),
      map(() => true),
      catchError(() => of(false)),
    );
  }

  updateProfile(data: { name?: string; email?: string }): Observable<AuthUser> {
    return this.http.patch<AuthUser>(`${this.baseUrl}/auth/profile`, data).pipe(
      tap(user => this.currentUser.set(user)),
    );
  }

  changePassword(currentPassword: string, newPassword: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.baseUrl}/auth/change-password`, { currentPassword, newPassword });
  }

  initialize(): Observable<void> {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!token) return of(undefined);

    return this.http.get<MeResponse>(`${this.baseUrl}/auth/me`).pipe(
      tap(user => {
        this.currentUser.set({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        });
        this.scheduleProactiveRefresh(token);
      }),
      map(() => undefined),
      catchError(() => {
        localStorage.removeItem(ACCESS_TOKEN_KEY);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        return of(undefined);
      }),
    );
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

  private decodeJwtPayload(token: string): { exp?: number; [key: string]: unknown } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      // Normalize base64url to base64: replace - with +, _ with /
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      // Pad to multiple of 4
      const padLen = (4 - (base64.length % 4)) % 4;
      base64 += '='.repeat(padLen);
      return JSON.parse(atob(base64));
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
