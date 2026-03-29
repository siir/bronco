import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatMenuModule } from '@angular/material/menu';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { UserService, type ControlPanelUser } from '../../core/services/user.service';
import { AuthService } from '../../core/services/auth.service';
import { UserDialogComponent } from './user-dialog.component';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatMenuModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatDialogModule,
  ],
  template: `
    <div class="page-header">
      <h1>User Maintenance</h1>
      <button mat-raised-button color="primary" (click)="openCreate()">
        <mat-icon>person_add</mat-icon>
        Create User
      </button>
    </div>

    @if (loading()) {
      <div class="loading">
        <mat-spinner diameter="40" />
      </div>
    } @else {
      <div class="user-grid">
        @for (user of users(); track user.id) {
          <mat-card [class.inactive]="!user.isActive">
            <mat-card-header>
              <mat-icon mat-card-avatar class="user-avatar">
                {{ user.role === 'ADMIN' ? 'admin_panel_settings' : 'person' }}
              </mat-icon>
              <mat-card-title>{{ user.name }}</mat-card-title>
              <mat-card-subtitle>{{ user.email }}</mat-card-subtitle>
              <button mat-icon-button [matMenuTriggerFor]="menu" class="card-menu">
                <mat-icon>more_vert</mat-icon>
              </button>
              <mat-menu #menu="matMenu">
                <button mat-menu-item (click)="openEdit(user)">
                  <mat-icon>edit</mat-icon>
                  <span>Edit</span>
                </button>
                <button mat-menu-item (click)="openResetPassword(user)">
                  <mat-icon>lock_reset</mat-icon>
                  <span>Reset Password</span>
                </button>
                @if (user.id !== currentUserId()) {
                  @if (user.isActive) {
                    <button mat-menu-item (click)="deactivate(user)">
                      <mat-icon>block</mat-icon>
                      <span>Deactivate</span>
                    </button>
                  } @else {
                    <button mat-menu-item (click)="activate(user)">
                      <mat-icon>check_circle</mat-icon>
                      <span>Activate</span>
                    </button>
                  }
                }
              </mat-menu>
            </mat-card-header>
            <mat-card-content>
              <div class="user-details">
                <div class="detail-row">
                  <mat-chip-set>
                    <mat-chip [highlighted]="user.role === 'ADMIN'" [class]="'role-' + user.role.toLowerCase()">
                      {{ user.role }}
                    </mat-chip>
                    @if (!user.isActive) {
                      <mat-chip class="role-inactive">INACTIVE</mat-chip>
                    }
                  </mat-chip-set>
                </div>
                <div class="detail-row muted">
                  <mat-icon class="detail-icon">schedule</mat-icon>
                  <span>Last login: {{ user.lastLoginAt ? (user.lastLoginAt | date:'short') : 'Never' }}</span>
                </div>
                <div class="detail-row muted">
                  <mat-icon class="detail-icon">calendar_today</mat-icon>
                  <span>Created: {{ user.createdAt | date:'mediumDate' }}</span>
                </div>
              </div>
            </mat-card-content>
          </mat-card>
        } @empty {
          <p class="empty-state">No users found.</p>
        }
      </div>
    }

    <!-- Reset Password Dialog (inline) -->
    @if (resetUser()) {
      <div class="overlay" (click)="resetUser.set(null)">
        <mat-card class="reset-dialog" (click)="$event.stopPropagation()">
          <mat-card-header>
            <mat-card-title>Reset Password</mat-card-title>
            <mat-card-subtitle>{{ resetUser()!.name }} ({{ resetUser()!.email }})</mat-card-subtitle>
          </mat-card-header>
          <mat-card-content>
            <mat-form-field class="full-width">
              <mat-label>New Password</mat-label>
              <input matInput [(ngModel)]="resetPassword" type="password" minlength="8">
              <mat-hint>Minimum 8 characters</mat-hint>
            </mat-form-field>
          </mat-card-content>
          <mat-card-actions align="end">
            <button mat-button (click)="resetUser.set(null)">Cancel</button>
            <button mat-raised-button color="primary" (click)="submitResetPassword()" [disabled]="resetPassword.length < 8">
              Reset
            </button>
          </mat-card-actions>
        </mat-card>
      </div>
    }
  `,
  styles: [`
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .page-header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 500;
    }
    .loading {
      display: flex;
      justify-content: center;
      padding: 48px;
    }
    .user-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 16px;
    }
    mat-card {
      position: relative;
    }
    mat-card.inactive {
      opacity: 0.6;
    }
    .user-avatar {
      font-size: 40px;
      width: 40px;
      height: 40px;
      color: #5c6bc0;
    }
    .card-menu {
      position: absolute;
      top: 8px;
      right: 8px;
    }
    .user-details {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .detail-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .detail-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .muted {
      color: #757575;
      font-size: 13px;
    }
    .role-admin {
      background: #e8eaf6 !important;
      color: #283593 !important;
    }
    .role-operator {
      background: #e0f2f1 !important;
      color: #00695c !important;
    }
    .role-inactive {
      background: #fce4ec !important;
      color: #c62828 !important;
    }
    .empty-state {
      text-align: center;
      color: #757575;
      padding: 48px;
    }
    .overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .reset-dialog {
      width: 400px;
      max-width: 90vw;
    }
    .full-width {
      width: 100%;
    }
  `],
})
export class UserListComponent implements OnInit {
  private userService = inject(UserService);
  private authService = inject(AuthService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  users = signal<ControlPanelUser[]>([]);
  loading = signal(false);
  resetUser = signal<ControlPanelUser | null>(null);
  resetPassword = '';

  currentUserId = () => this.authService.currentUser()?.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.userService.getUsers().subscribe({
      next: (users) => {
        this.users.set(users);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.snackBar.open(err.error?.message ?? err.error?.error ?? 'Failed to load users', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  openCreate(): void {
    const ref = this.dialog.open(UserDialogComponent, {
      width: '450px',
      data: {},
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.load();
    });
  }

  openEdit(user: ControlPanelUser): void {
    const ref = this.dialog.open(UserDialogComponent, {
      width: '450px',
      data: { user, currentUserId: this.currentUserId() },
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.load();
    });
  }

  openResetPassword(user: ControlPanelUser): void {
    this.resetPassword = '';
    this.resetUser.set(user);
  }

  submitResetPassword(): void {
    const user = this.resetUser();
    if (!user) return;
    this.userService.resetPassword(user.id, this.resetPassword).subscribe({
      next: () => {
        this.snackBar.open('Password reset successfully', 'OK', { duration: 3000 });
        this.resetUser.set(null);
        this.resetPassword = '';
      },
      error: (err) => this.snackBar.open(err.error?.message ?? err.error?.error ?? 'Reset failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  deactivate(user: ControlPanelUser): void {
    this.userService.deleteUser(user.id).subscribe({
      next: () => {
        this.snackBar.open('User deactivated', 'OK', { duration: 3000 });
        this.load();
      },
      error: (err) => this.snackBar.open(err.error?.message ?? err.error?.error ?? 'Deactivation failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  activate(user: ControlPanelUser): void {
    this.userService.updateUser(user.id, { isActive: true }).subscribe({
      next: () => {
        this.snackBar.open('User activated', 'OK', { duration: 3000 });
        this.load();
      },
      error: (err) => this.snackBar.open(err.error?.message ?? err.error?.error ?? 'Activation failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
}
