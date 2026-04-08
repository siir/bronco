import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { ClientUser, ClientUserService } from '../../../../core/services/client-user.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
} from '../../../../shared/components/index.js';
import { ClientUserDialogComponent } from '../../client-user-dialog.component';

@Component({
  selector: 'app-client-users-tab',
  standalone: true,
  imports: [
    DatePipe,
    BroncoButtonComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    ClientUserDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Portal Users</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openAddDialog()">+ Add User</app-bronco-button>
      </div>

      <app-data-table
        [data]="users()"
        [trackBy]="trackById"
        [rowClickable]="false"
        emptyMessage="No portal users for this client.">
        <app-data-column key="name" header="Name" [sortable]="false">
          <ng-template #cell let-u>{{ u.name }}</ng-template>
        </app-data-column>
        <app-data-column key="email" header="Email" [sortable]="false">
          <ng-template #cell let-u>{{ u.email }}</ng-template>
        </app-data-column>
        <app-data-column key="userType" header="Type" [sortable]="false" width="100px">
          <ng-template #cell let-u>
            <span class="chip" [class.chip-admin]="u.userType === 'ADMIN'" [class.chip-user]="u.userType !== 'ADMIN'">
              {{ u.userType }}
            </span>
          </ng-template>
        </app-data-column>
        <app-data-column key="isActiveUser" header="Status" [sortable]="false" width="110px">
          <ng-template #cell let-u>
            <span class="chip" [class.chip-active]="u.isActive" [class.chip-inactive]="!u.isActive">
              {{ u.isActive ? 'Active' : 'Inactive' }}
            </span>
          </ng-template>
        </app-data-column>
        <app-data-column key="lastLogin" header="Last Login" [sortable]="false" width="160px">
          <ng-template #cell let-u>
            @if (u.lastLoginAt) {
              {{ u.lastLoginAt | date:'short' }}
            } @else {
              <span class="muted">Never</span>
            }
          </ng-template>
        </app-data-column>
        <app-data-column key="actions" header="" [sortable]="false" width="100px">
          <ng-template #cell let-u>
            <div class="row-actions">
              <app-bronco-button variant="icon" size="sm" ariaLabel="Edit user" (click)="openEditDialog(u)">&#x270E;</app-bronco-button>
              <app-bronco-button variant="icon" size="sm" ariaLabel="Deactivate user" (click)="deleteUser(u.id)">&#x1F6AB;</app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        [title]="editing() ? 'Edit User' : 'Create Portal User'"
        maxWidth="500px"
        (openChange)="showDialog.set(false)">
        <app-client-user-dialog-content
          [clientId]="clientId()"
          [user]="editing() ?? undefined"
          (saved)="onSaved()"
          (cancelled)="showDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    :host { display: block; }

    .tab-section { padding: 16px 0; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .chip {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
      white-space: nowrap;
    }
    .chip-admin {
      background: var(--color-info-subtle);
      color: var(--color-info);
    }
    .chip-user {
      background: var(--bg-muted);
      color: var(--text-secondary);
    }
    .chip-active {
      background: var(--color-success-subtle);
      color: var(--color-success);
    }
    .chip-inactive {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }

    .muted { color: var(--text-tertiary); }

    .row-actions {
      display: inline-flex;
      gap: 4px;
    }
  `],
})
export class ClientUsersTabComponent implements OnInit {
  clientId = input.required<string>();

  private userService = inject(ClientUserService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  users = signal<ClientUser[]>([]);
  showDialog = signal(false);
  editing = signal<ClientUser | null>(null);

  trackById = (u: ClientUser): string => u.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.userService.getUsers(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(u => this.users.set(u));
  }

  openAddDialog(): void {
    this.editing.set(null);
    this.showDialog.set(true);
  }

  openEditDialog(user: ClientUser): void {
    this.editing.set(user);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }

  deleteUser(id: string): void {
    this.userService.deleteUser(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('User deactivated');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Deactivation failed'),
      });
  }
}
