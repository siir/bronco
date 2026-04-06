import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AuthService } from '../../core/services/auth.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule],
  template: `
    <div class="login-wrapper">
      <mat-card class="login-card">
        <mat-card-header>
          <mat-card-title>iTrack 3</mat-card-title>
          <mat-card-subtitle>with iTrackAI® · Control Panel</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Email</mat-label>
            <input matInput type="email" [(ngModel)]="email" (keyup.enter)="login()">
            <mat-icon matPrefix>email</mat-icon>
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Password</mat-label>
            <input matInput [type]="showPassword() ? 'text' : 'password'" [(ngModel)]="password" (keyup.enter)="login()">
            <mat-icon matPrefix>lock</mat-icon>
            <button mat-icon-button matSuffix (click)="showPassword.set(!showPassword())" type="button">
              <mat-icon>{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
            </button>
          </mat-form-field>
        </mat-card-content>
        <mat-card-actions>
          <button mat-raised-button color="primary" class="full-width" (click)="login()" [disabled]="loading()">
            @if (loading()) {
              Signing in...
            } @else {
              Sign In
            }
          </button>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: [`
    .login-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #f5f5f5;
    }
    .login-card {
      width: 100%;
      max-width: 400px;
    }
    mat-card-header {
      margin-bottom: 16px;
    }
    .full-width {
      width: 100%;
    }
    mat-card-actions .full-width {
      margin: 0;
    }
  `],
})
export class LoginComponent {
  private authService = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  email = '';
  password = '';
  showPassword = signal(false);
  loading = signal(false);

  login(): void {
    if (!this.email || !this.password) {
      this.snackBar.open('Email and password are required', 'OK', { duration: 3000, panelClass: 'error-snackbar' });
      return;
    }

    this.loading.set(true);
    this.authService.login(this.email, this.password).subscribe({
      error: (err) => {
        this.loading.set(false);
        const message = err.error?.error ?? 'Login failed';
        this.snackBar.open(message, 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }
}
