import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AuthService } from '../../core/services/auth.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatCardModule, MatIconModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <h1>Profile</h1>

    @if (authService.currentUser(); as user) {
      <mat-card>
        <mat-card-header>
          <mat-icon mat-card-avatar style="font-size: 40px; width: 40px; height: 40px;">account_circle</mat-icon>
          <mat-card-title>{{ user.name }}</mat-card-title>
          <mat-card-subtitle>{{ user.role }}</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <div class="field">
            <span class="label">User ID</span>
            <span class="mono">{{ user.id }}</span>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card class="section-card">
        <mat-card-header>
          <mat-card-title>Edit Profile</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Name</mat-label>
            <input matInput [(ngModel)]="profileName" />
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Email</mat-label>
            <input matInput type="email" [(ngModel)]="profileEmail" />
          </mat-form-field>
        </mat-card-content>
        <mat-card-actions>
          <button mat-raised-button color="primary" (click)="saveProfile()" [disabled]="profileSaving">
            Save Changes
          </button>
        </mat-card-actions>
      </mat-card>

      <mat-card class="section-card">
        <mat-card-header>
          <mat-card-title>Change Password</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Current Password</mat-label>
            <input matInput type="password" [(ngModel)]="currentPassword" />
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>New Password</mat-label>
            <input matInput type="password" [(ngModel)]="newPassword" />
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Confirm New Password</mat-label>
            <input matInput type="password" [(ngModel)]="confirmPassword" />
          </mat-form-field>
        </mat-card-content>
        <mat-card-actions>
          <button mat-raised-button color="warn" (click)="changePassword()" [disabled]="passwordSaving">
            Change Password
          </button>
        </mat-card-actions>
      </mat-card>
    }
  `,
  styles: [`
    h1 { margin: 0 0 24px; }
    .section-card { margin-top: 24px; }
    .full-width { width: 100%; }
    .field {
      display: flex;
      flex-direction: column;
      margin-top: 16px;
    }
    .label {
      font-size: 12px;
      color: #666;
      margin-bottom: 4px;
    }
    .mono {
      font-family: monospace;
      font-size: 13px;
    }
  `],
})
export class ProfileComponent implements OnInit {
  authService = inject(AuthService);
  private snackBar = inject(MatSnackBar);

  profileName = '';
  profileEmail = '';
  profileSaving = false;

  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  passwordSaving = false;

  ngOnInit(): void {
    const user = this.authService.currentUser();
    if (user) {
      this.profileName = user.name;
      this.profileEmail = user.email;
    }
  }

  saveProfile(): void {
    this.profileSaving = true;
    this.authService.updateProfile({ name: this.profileName, email: this.profileEmail }).subscribe({
      next: () => {
        this.snackBar.open('Profile updated', 'OK', { duration: 3000 });
        this.profileSaving = false;
      },
      error: (err) => {
        this.snackBar.open(err.error?.error ?? 'Failed to update profile', 'OK', { duration: 5000 });
        this.profileSaving = false;
      },
    });
  }

  changePassword(): void {
    if (this.newPassword !== this.confirmPassword) {
      this.snackBar.open('New passwords do not match', 'OK', { duration: 5000 });
      return;
    }
    if (this.newPassword.length < 8) {
      this.snackBar.open('Password must be at least 8 characters', 'OK', { duration: 5000 });
      return;
    }
    this.passwordSaving = true;
    this.authService.changePassword(this.currentPassword, this.newPassword).subscribe({
      next: () => {
        this.snackBar.open('Password changed successfully', 'OK', { duration: 3000 });
        this.currentPassword = '';
        this.newPassword = '';
        this.confirmPassword = '';
        this.passwordSaving = false;
      },
      error: (err) => {
        this.snackBar.open(err.error?.error ?? 'Failed to change password', 'OK', { duration: 5000 });
        this.passwordSaving = false;
      },
    });
  }
}
