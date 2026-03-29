import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of, tap, map, catchError, shareReplay, finalize, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  clientId: string;
  userType: 'ADMIN' | 'USER';
  client?: { name: string; shortCode: string };
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: PortalUser;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

const ACCESS_TOKEN_KEY = 'rc_portal_access_token';
const REFRESH_TOKEN_KEY = 'rc_portal_refresh_token';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private baseUrl = environment.apiUrl;
  private refreshInFlight$: Observable<RefreshResponse> | null = null;
  private refreshTimerHandle: ReturnType<typeof setTimeout> | null = null;

  currentUser = signal<PortalUser | null>(null);

  get accessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  }

  login(email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.baseUrl}/portal/auth/login`, { email, password }).pipe(
      tap(res => {
        localStorage.setItem(ACCESS_TOKEN_KEY, res.accessToken);
        localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
        this.currentUser.set(res.user);
        this.scheduleProactiveRefresh(res.accessToken);
        this.router.navigateByUrl('/dashboard');
      }),
    );
  }

  register(name: string, email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.baseUrl}/portal/auth/register`, { name, email, password }).pipe(
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

    this.refreshInFlight$ = this.http.post<RefreshResponse>(`${this.baseUrl}/portal/auth/refresh`, { refreshToken }).pipe(
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
      switchMap(() => this.http.get<PortalUser & { isActive: boolean; lastLoginAt: string | null; createdAt: string }>(`${this.baseUrl}/portal/auth/me`)),
      tap(user => {
        this.currentUser.set({
          id: user.id,
          email: user.email,
          name: user.name,
          clientId: user.clientId,
          userType: user.userType,
          client: user.client,
        });
      }),
      map(() => true),
      catchError(() => of(false)),
    );
  }

  updateProfile(data: { name?: string; email?: string }): Observable<PortalUser> {
    return this.http.patch<PortalUser>(`${this.baseUrl}/portal/auth/profile`, data).pipe(
      tap(user => this.currentUser.update(prev => prev ? { ...prev, ...user } : null)),
    );
  }

  changePassword(currentPassword: string, newPassword: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.baseUrl}/portal/auth/change-password`, { currentPassword, newPassword });
  }

  initialize(): Observable<void> {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!token) return of(undefined);

    return this.http.get<PortalUser & { isActive: boolean; lastLoginAt: string | null; createdAt: string }>(`${this.baseUrl}/portal/auth/me`).pipe(
      tap(user => {
        this.currentUser.set({
          id: user.id,
          email: user.email,
          name: user.name,
          clientId: user.clientId,
          userType: user.userType,
          client: user.client,
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

  private decodeJwtPayload(token: string): { exp?: number; [key: string]: unknown } | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
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
