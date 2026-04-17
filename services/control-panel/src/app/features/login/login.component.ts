import { Component, inject, signal } from '@angular/core';
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
      error: (err) => {
        this.loading.set(false);
        const message = err.error?.error ?? 'Login failed';
        this.toast.error(message);
      },
    });
  }
}
