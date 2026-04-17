import { Component, inject, signal, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { UserService, type ControlPanelUser } from '../../core/services/user.service.js';
import { AuthService } from '../../core/services/auth.service.js';
import { UserDialogComponent } from './user-dialog.component.js';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
  DropdownMenuComponent,
  DropdownItemComponent,
  DialogComponent,
  DataTableComponent,
  DataTableColumnComponent,
} from '../../shared/components/index.js';
import { ViewportService } from '../../core/services/viewport.service.js';
import { ToastService } from '../../core/services/toast.service.js';

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
    DataTableComponent,
    DataTableColumnComponent,
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
        <app-data-table
          [data]="users()"
          [trackBy]="trackById"
          [rowClickable]="viewport.isMobile()"
          (rowClick)="onRowClick($event)"
          emptyMessage="No users found.">

          <app-data-column key="user" header="User" [sortable]="false" mobilePriority="primary">
            <ng-template #cell let-row>
              <div class="user-cell" [class.inactive]="!row.isActive">
                <div class="avatar" [class.admin-avatar]="row.role === 'ADMIN'">
                  {{ row.name.charAt(0).toUpperCase() }}
                </div>
                <div class="user-text">
                  <div class="user-name">{{ row.name }}</div>
                  <div class="user-email">{{ row.email }}</div>
                </div>
              </div>
            </ng-template>
          </app-data-column>

          <app-data-column key="role" header="Role" width="110px" [sortable]="false" mobilePriority="secondary">
            <ng-template #cell let-row>
              <span class="chip" [class]="'role-' + row.role.toLowerCase()">{{ row.role }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="status" header="Status" width="100px" [sortable]="false" mobilePriority="secondary">
            <ng-template #cell let-row>
              @if (row.isActive) {
                <span class="status-active">Active</span>
              } @else {
                <span class="chip role-inactive">INACTIVE</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="lastLogin" header="Last Login" width="160px" [sortable]="false" mobilePriority="secondary">
            <ng-template #cell let-row>
              <span class="muted">{{ row.lastLoginAt ? (row.lastLoginAt | date:'short') : 'Never' }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="created" header="Created" width="140px" [sortable]="false" mobilePriority="hidden">
            <ng-template #cell let-row>
              <span class="muted">{{ row.createdAt | date:'mediumDate' }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="actions" header="" width="60px" [sortable]="false" mobilePriority="hidden">
            <ng-template #cell let-row>
              <app-bronco-button variant="icon" size="sm" [attr.aria-label]="'Actions for ' + row.name" (click)="onActionsClick(row, $event)">
                ...
              </app-bronco-button>
            </ng-template>
          </app-data-column>
        </app-data-table>

        <!--
          Always render the dropdown so ViewChild resolves on first render.
          Gating the whole dropdown on @if (openMenuRow()) caused the
          ViewChild to be undefined on the first click, requiring a second
          click to open. The dropdown's internal state (isOpen) controls
          visibility; only the content (which needs the active row) is
          conditionally rendered.
        -->
        <app-dropdown-menu #menu [trigger]="menuTriggerEl" (closed)="openMenuRow.set(null)">
          @if (openMenuRow(); as activeRow) {
            <app-dropdown-item (action)="openEdit(activeRow)">Edit</app-dropdown-item>
            <app-dropdown-item (action)="openResetPassword(activeRow)">Reset Password</app-dropdown-item>
            @if (activeRow.id !== currentUserId()) {
              @if (activeRow.isActive) {
                <app-dropdown-item (action)="deactivate(activeRow)">Deactivate</app-dropdown-item>
              } @else {
                <app-dropdown-item (action)="activate(activeRow)">Activate</app-dropdown-item>
              }
            }
          }
        </app-dropdown-menu>
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

    .user-cell {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .user-cell.inactive { opacity: 0.6; }
    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--text-on-accent);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .admin-avatar { background: #5856d6; }
    .user-text { min-width: 0; }
    .user-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .user-email {
      font-size: 12px;
      color: var(--text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .muted {
      color: var(--text-tertiary);
      font-size: 13px;
    }

    .status-active {
      font-size: 12px;
      font-weight: 500;
      color: var(--color-success);
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
  readonly viewport = inject(ViewportService);

  @ViewChild('menu') private menu?: DropdownMenuComponent;

  users = signal<ControlPanelUser[]>([]);
  loading = signal(false);
  resetUser = signal<ControlPanelUser | null>(null);
  resetPassword = '';
  showUserDialog = signal(false);
  editingUser = signal<ControlPanelUser | null>(null);
  openMenuRow = signal<ControlPanelUser | null>(null);
  menuTriggerEl: HTMLElement | null = null;

  currentUserId = () => this.authService.currentUser()?.id;

  trackById = (item: ControlPanelUser) => item.id;

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

  onActionsClick(user: ControlPanelUser, event: Event): void {
    event.stopPropagation();
    const currentTarget = event.currentTarget;
    this.menuTriggerEl = currentTarget instanceof HTMLElement ? currentTarget : null;
    this.openMenuRow.set(user);
    // Set the trigger on the menu directly — the `[trigger]` template binding
    // doesn't propagate until the next CD cycle, so calling open() synchronously
    // after updating menuTriggerEl would see the stale trigger and no-op.
    if (this.menu) {
      this.menu.trigger = this.menuTriggerEl;
      this.menu.open();
    }
  }

  // On mobile, tapping the card is the primary edit affordance since the
  // overflow menu column is hidden. Desktop has rowClickable=false, so
  // this is a no-op there.
  onRowClick(user: ControlPanelUser): void {
    this.openEdit(user);
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
