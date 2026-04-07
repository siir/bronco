import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { UserService, type ControlPanelUser } from '../../core/services/user.service';
import { AuthService } from '../../core/services/auth.service';
import { UserDialogComponent } from './user-dialog.component';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
  DropdownMenuComponent,
  DropdownItemComponent,
  DialogComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    BroncoButtonComponent,
    CardComponent,
    FormFieldComponent,
    DropdownMenuComponent,
    DropdownItemComponent,
    DialogComponent,
    UserDialogComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1 class="page-title">User Maintenance</h1>
        <app-bronco-button variant="primary" (click)="openCreate()">
          Create User
        </app-bronco-button>
      </div>

      @if (loading()) {
        <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
      } @else {
        <div class="user-grid">
          @for (user of users(); track user.id) {
            <div class="user-card" [class.inactive]="!user.isActive">
              <div class="card-header">
                <div class="avatar" [class.admin-avatar]="user.role === 'ADMIN'">
                  {{ user.name.charAt(0).toUpperCase() }}
                </div>
                <div class="header-text">
                  <div class="user-name">{{ user.name }}</div>
                  <div class="user-email">{{ user.email }}</div>
                </div>
                <app-bronco-button variant="icon" size="sm" class="card-menu" [attr.aria-label]="'Actions for ' + user.name" #menuTrigger (click)="menu.toggle()">
                  ...
                </app-bronco-button>
                <app-dropdown-menu #menu [trigger]="menuTrigger">
                  <app-dropdown-item (action)="openEdit(user)">Edit</app-dropdown-item>
                  <app-dropdown-item (action)="openResetPassword(user)">Reset Password</app-dropdown-item>
                  @if (user.id !== currentUserId()) {
                    @if (user.isActive) {
                      <app-dropdown-item (action)="deactivate(user)">Deactivate</app-dropdown-item>
                    } @else {
                      <app-dropdown-item (action)="activate(user)">Activate</app-dropdown-item>
                    }
                  }
                </app-dropdown-menu>
              </div>
              <div class="user-details">
                <div class="detail-row">
                  <span class="chip" [class]="'role-' + user.role.toLowerCase()">{{ user.role }}</span>
                  @if (!user.isActive) {
                    <span class="chip role-inactive">INACTIVE</span>
                  }
                </div>
                <div class="detail-row muted">
                  Last login: {{ user.lastLoginAt ? (user.lastLoginAt | date:'short') : 'Never' }}
                </div>
                <div class="detail-row muted">
                  Created: {{ user.createdAt | date:'mediumDate' }}
                </div>
              </div>
            </div>
          } @empty {
            <p class="empty-state">No users found.</p>
          }
        </div>
      }

      @if (showUserDialog()) {
        <app-dialog [open]="true" [title]="editingUser() ? 'Edit User' : 'Create User'" maxWidth="450px" (openChange)="showUserDialog.set(false)">
          <app-user-dialog-content
            [user]="editingUser() ?? undefined"
            [currentUserId]="currentUserId() ?? undefined"
            (saved)="onUserSaved()"
            (cancelled)="showUserDialog.set(false)" />
        </app-dialog>
      }

      <!-- Reset Password Dialog (inline) -->
      @if (resetUser()) {
        <div class="overlay" (click)="resetUser.set(null)">
          <div class="reset-dialog" (click)="$event.stopPropagation()">
            <app-card>
              <h2 class="section-title">Reset Password</h2>
              <p class="reset-subtitle">{{ resetUser()!.name }} ({{ resetUser()!.email }})</p>
              <app-form-field label="New Password" hint="Minimum 8 characters">
                <input class="text-input" [(ngModel)]="resetPassword" type="password" minlength="8">
              </app-form-field>
              <div class="card-actions">
                <app-bronco-button variant="ghost" (click)="resetUser.set(null)">Cancel</app-bronco-button>
                <app-bronco-button variant="primary" (click)="submitResetPassword()" [disabled]="resetPassword.length < 8">
                  Reset
                </app-bronco-button>
              </div>
            </app-card>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .page-title {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .loading-wrapper {
      display: flex;
      justify-content: center;
      padding: 48px;
    }
    .loading-text { color: var(--text-tertiary); font-size: 13px; }

    .user-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }
    .user-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      padding: 20px;
      box-shadow: var(--shadow-card);
      position: relative;
    }
    .user-card.inactive { opacity: 0.6; }

    .card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--text-on-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 17px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .admin-avatar { background: #5856d6; }
    .header-text { flex: 1; min-width: 0; }
    .user-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .user-email {
      font-size: 13px;
      color: var(--text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-menu { flex-shrink: 0; }

    .user-details {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .detail-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .muted {
      color: var(--text-tertiary);
      font-size: 13px;
    }

    .chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 10px;
      border-radius: var(--radius-pill);
      text-transform: uppercase;
    }
    .role-admin { background: rgba(88, 86, 214, 0.1); color: #5856d6; }
    .role-operator { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .role-inactive { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }

    .empty-state {
      text-align: center;
      color: var(--text-tertiary);
      padding: 48px;
    }

    .overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .reset-dialog {
      width: 400px;
      max-width: 90vw;
    }
    .section-title {
      margin: 0 0 4px;
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .reset-subtitle {
      font-size: 13px;
      color: var(--text-tertiary);
      margin: 0 0 16px;
    }

    .text-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .text-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.15);
    }

    .card-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
    }
  `],
})
export class UserListComponent implements OnInit {
  private userService = inject(UserService);
  private authService = inject(AuthService);
  private toast = inject(ToastService);

  users = signal<ControlPanelUser[]>([]);
  loading = signal(false);
  resetUser = signal<ControlPanelUser | null>(null);
  resetPassword = '';
  showUserDialog = signal(false);
  editingUser = signal<ControlPanelUser | null>(null);

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
        this.toast.error(err.error?.message ?? err.error?.error ?? 'Failed to load users');
      },
    });
  }

  openCreate(): void {
    this.editingUser.set(null);
    this.showUserDialog.set(true);
  }

  openEdit(user: ControlPanelUser): void {
    this.editingUser.set(user);
    this.showUserDialog.set(true);
  }

  onUserSaved(): void {
    this.showUserDialog.set(false);
    this.load();
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
        this.toast.success('Password reset successfully');
        this.resetUser.set(null);
        this.resetPassword = '';
      },
      error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Reset failed'),
    });
  }

  deactivate(user: ControlPanelUser): void {
    this.userService.deleteUser(user.id).subscribe({
      next: () => {
        this.toast.success('User deactivated');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Deactivation failed'),
    });
  }

  activate(user: ControlPanelUser): void {
    this.userService.updateUser(user.id, { isActive: true }).subscribe({
      next: () => {
        this.toast.success('User activated');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Activation failed'),
    });
  }
}
