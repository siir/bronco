import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/services/auth.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import {
  CardComponent,
  FormFieldComponent,
  TextInputComponent,
  BroncoButtonComponent,
} from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [CardComponent, FormFieldComponent, TextInputComponent, BroncoButtonComponent],
  template: `
    <div class="login-wrapper">
      <app-card padding="lg" class="login-card">
        <div class="login-header">
          <h1 class="login-title">iTrack 3</h1>
          <p class="login-subtitle">with iTrackAI® · Control Panel</p>
        </div>
        <div class="login-fields">
          <app-form-field label="Email">
            <app-text-input
              type="email"
              [value]="email"
              placeholder="you@example.com"
              (valueChange)="email = $event"
              (keyup.enter)="login()" />
          </app-form-field>
          <app-form-field label="Password">
            <app-text-input
              type="password"
              [value]="password"
              (valueChange)="password = $event"
              (keyup.enter)="login()" />
          </app-form-field>
        </div>
        <div class="full-width-button-wrap">
          <app-bronco-button variant="primary" size="lg" [fullWidth]="true" [disabled]="loading()" (click)="login()">
            @if (loading()) { Signing in... } @else { Sign In }
          </app-bronco-button>
        </div>
      </app-card>
    </div>
  `,
  styles: [`
    .login-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: var(--bg-page);
    }

    .login-card {
      display: block;
      width: 100%;
      max-width: 400px;
    }

    .login-header {
      text-align: center;
      margin-bottom: 28px;
    }

    .login-title {
      font-family: var(--font-primary);
      font-size: 22px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 6px;
    }

    .login-subtitle {
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 400;
      color: var(--text-tertiary);
      margin: 0;
    }

    .login-fields {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 24px;
    }

    .full-width-button-wrap {
      display: block;
      width: 100%;
    }
  `],
})
export class LoginComponent {
  private authService = inject(AuthService);
  private toast = inject(ToastService);

  email = '';
  password = '';
  loading = signal(false);

  login(): void {
    if (!this.email || !this.password) {
      this.toast.error('Email and password are required');
      return;
    }

    this.loading.set(true);
    this.authService.login(this.email, this.password).subscribe({
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.toast.error(describeLoginError(err));
      },
    });
  }
}

/**
 * Produce a user-facing message from an auth-login HTTP error. Covers four
 * common shapes so the operator isn't left squinting at a generic "Login
 * failed" toast while the real cause hides in DevTools.
 */
function describeLoginError(err: HttpErrorResponse): string {
  // status 0 = browser couldn't reach the server (CORS, DNS, offline, proxy
  // refused the upstream). Message the network layer, not the app.
  if (err.status === 0) {
    return 'Cannot reach the server. Check your connection or that the API is running.';
  }
  // Body-provided error from copilot-api (e.g., { error: 'Invalid credentials' }).
  const bodyMessage = typeof err.error === 'object' && err.error !== null
    ? (err.error as { error?: string; message?: string }).error
      ?? (err.error as { error?: string; message?: string }).message
    : typeof err.error === 'string' ? err.error : undefined;
  if (bodyMessage) return bodyMessage;
  // Generic status-based fallbacks.
  if (err.status === 401) return 'Invalid email or password.';
  if (err.status === 403) return 'Account is inactive or does not have control panel access.';
  if (err.status >= 500) return `Server error (${err.status}). Try again in a moment.`;
  return err.message ?? 'Login failed.';
}
