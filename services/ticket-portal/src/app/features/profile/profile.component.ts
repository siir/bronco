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
    <h1>Profile</h1>

    @if (user(); as u) {
      <mat-card class="section">
        <mat-card-header><mat-card-title>Account Info</mat-card-title></mat-card-header>
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Name</mat-label>
            <input matInput [(ngModel)]="name">
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Email</mat-label>
            <input matInput [(ngModel)]="email" type="email">
          </mat-form-field>
        </mat-card-content>
        <mat-card-actions align="end">
          <button mat-raised-button color="primary" (click)="updateProfile()" [disabled]="saving()">
            {{ saving() ? 'Saving...' : 'Save Changes' }}
          </button>
        </mat-card-actions>
      </mat-card>

      <mat-card class="section">
        <mat-card-header><mat-card-title>Change Password</mat-card-title></mat-card-header>
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Current Password</mat-label>
            <input matInput [(ngModel)]="currentPassword" type="password">
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>New Password</mat-label>
            <input matInput [(ngModel)]="newPassword" type="password" minlength="8">
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Confirm New Password</mat-label>
            <input matInput [(ngModel)]="confirmPassword" type="password">
          </mat-form-field>
        </mat-card-content>
        <mat-card-actions align="end">
          <button mat-raised-button color="primary" (click)="changePassword()"
            [disabled]="changingPassword() || !currentPassword || !newPassword || newPassword !== confirmPassword || newPassword.length < 8">
            {{ changingPassword() ? 'Changing...' : 'Change Password' }}
          </button>
        </mat-card-actions>
      </mat-card>

      <div class="account-meta">
        <p><strong>User Type:</strong> {{ u.userType }}</p>
        @if (u.client) {
          <p><strong>Company:</strong> {{ u.client.name }}</p>
        }
      </div>
    }
  `,
  styles: [`
    .section { margin-bottom: 24px; }
    .full-width { width: 100%; margin-bottom: 8px; }
    .account-meta { color: #666; font-size: 13px; }
    .account-meta p { margin: 4px 0; }
  `],
})
export class ProfileComponent {
  private authService = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  user = this.authService.currentUser;
  name = this.user()?.name ?? '';
  email = this.user()?.email ?? '';
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  saving = signal(false);
  changingPassword = signal(false);

  updateProfile(): void {
    this.saving.set(true);
    this.authService.updateProfile({ name: this.name, email: this.email }).subscribe({
      next: () => {
        this.saving.set(false);
        this.snackBar.open('Profile updated', 'OK', { duration: 3000 });
      },
      error: (err) => {
        this.saving.set(false);
        this.snackBar.open(err.error?.error ?? 'Update failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  changePassword(): void {
    this.changingPassword.set(true);
    this.authService.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: () => {
        this.changingPassword.set(false);
        this.currentPassword = '';
        this.newPassword = '';
        this.confirmPassword = '';
        this.snackBar.open('Password changed', 'OK', { duration: 3000 });
      },
      error: (err) => {
        this.changingPassword.set(false);
        this.snackBar.open(err.error?.error ?? 'Password change failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }
}
