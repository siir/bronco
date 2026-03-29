import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AuthService } from '../../core/services/auth.service';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule],
  template: `
    <div class="register-wrapper">
      <mat-card class="register-card">
        <mat-card-header>
          <mat-card-title>Register</mat-card-title>
          <mat-card-subtitle>Create a portal account using your company email</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Full Name</mat-label>
            <input matInput [(ngModel)]="name" (keyup.enter)="register()">
            <mat-icon matPrefix>person</mat-icon>
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Company Email</mat-label>
            <input matInput type="email" [(ngModel)]="email" (keyup.enter)="register()">
            <mat-icon matPrefix>email</mat-icon>
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Password</mat-label>
            <input matInput [type]="showPassword() ? 'text' : 'password'" [(ngModel)]="password" (keyup.enter)="register()">
            <mat-icon matPrefix>lock</mat-icon>
            <button mat-icon-button matSuffix (click)="showPassword.set(!showPassword())" type="button" [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'">
              <mat-icon>{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
            </button>
            <mat-hint>At least 8 characters</mat-hint>
          </mat-form-field>
        </mat-card-content>
        <mat-card-actions>
          <button mat-raised-button color="primary" class="full-width" (click)="register()" [disabled]="loading()">
            @if (loading()) {
              Creating account...
            } @else {
              Create Account
            }
          </button>
          <a routerLink="/login" class="login-link">Already have an account? Sign in</a>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: [`
    .register-wrapper {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: #f5f5f5;
    }
    .register-card {
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
    .login-link {
      display: block;
      text-align: center;
      margin-top: 12px;
      font-size: 13px;
      color: #1565c0;
      text-decoration: none;
    }
  `],
})
export class RegisterComponent {
  private authService = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  name = '';
  email = '';
  password = '';
  showPassword = signal(false);
  loading = signal(false);

  register(): void {
    if (!this.name || !this.email || !this.password) {
      this.snackBar.open('All fields are required', 'OK', { duration: 3000, panelClass: 'error-snackbar' });
      return;
    }

    if (this.password.length < 8) {
      this.snackBar.open('Password must be at least 8 characters', 'OK', { duration: 3000, panelClass: 'error-snackbar' });
      return;
    }

    this.loading.set(true);
    this.authService.register(this.name, this.email, this.password).subscribe({
      error: (err) => {
        this.loading.set(false);
        const message = err.error?.error ?? 'Registration failed';
        this.snackBar.open(message, 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }
}
