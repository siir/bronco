import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Person, PersonService } from '../../../../core/services/person.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
  IconComponent,
} from '../../../../shared/components/index.js';
import { PersonDialogComponent } from '../../../people/person-dialog.component';

@Component({
  selector: 'app-client-people-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    IconComponent,
    PersonDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">People</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openAddDialog()">+ Add Person</app-bronco-button>
      </div>

      <app-data-table
        [data]="people()"
        [trackBy]="trackById"
        [rowClickable]="false"
        emptyMessage="No people added.">
        <app-data-column key="name" header="Name" [sortable]="false">
          <ng-template #cell let-p>
            {{ p.name }}
            @if (p.isPrimary) {
              <span class="primary-star" title="Primary contact"><app-icon name="star" size="xs" /></span>
            }
          </ng-template>
        </app-data-column>
        <app-data-column key="email" header="Email" [sortable]="false">
          <ng-template #cell let-p>{{ p.email }}</ng-template>
        </app-data-column>
        <app-data-column key="role" header="Role" [sortable]="false">
          <ng-template #cell let-p>{{ p.role ?? '-' }}</ng-template>
        </app-data-column>
        <app-data-column key="access" header="Access" [sortable]="false" width="130px">
          <ng-template #cell let-p>
            <span class="chip" [class.chip-admin]="accessLabel(p) === 'Ops Admin' || accessLabel(p) === 'Portal Admin'" [class.chip-operator]="accessLabel(p) === 'Ops Operator' || accessLabel(p) === 'Portal Operator'" [class.chip-user]="accessLabel(p) === 'Portal User' || accessLabel(p) === 'Contact'">
              {{ accessLabel(p) }}
            </span>
          </ng-template>
        </app-data-column>
        <app-data-column key="status" header="Status" [sortable]="false" width="110px">
          <ng-template #cell let-p>
            @if (p.hasPortalAccess) {
              <span class="chip" [class.chip-active]="p.isActive" [class.chip-inactive]="!p.isActive">
                {{ p.isActive ? 'Active' : 'Inactive' }}
              </span>
            } @else {
              <span class="muted">-</span>
            }
          </ng-template>
        </app-data-column>
        <app-data-column key="actions" header="" [sortable]="false" width="100px">
          <ng-template #cell let-p>
            <div class="row-actions">
              <app-bronco-button variant="icon" size="sm" ariaLabel="Edit person" (click)="openEditDialog(p)"><app-icon name="edit" size="sm" /></app-bronco-button>
              <app-bronco-button variant="icon" size="sm" ariaLabel="Delete person" (click)="deletePerson(p)"><app-icon name="delete" size="sm" /></app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        [title]="editing() ? 'Edit Person' : 'Add Person'"
        maxWidth="500px"
        (openChange)="showDialog.set(false)">
        <app-person-dialog-content
          [clientId]="clientId()"
          [person]="editing() ?? undefined"
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

    .primary-star {
      color: var(--color-warning);
      font-size: 16px;
      line-height: 1;
      margin-left: 4px;
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
    .chip-operator {
      background: var(--color-warning-subtle, var(--bg-muted));
      color: var(--color-warning, var(--text-secondary));
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
export class ClientPeopleTabComponent implements OnInit {
  clientId = input.required<string>();

  private personService = inject(PersonService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  people = signal<Person[]>([]);
  showDialog = signal(false);
  editing = signal<Person | null>(null);

  trackById = (p: Person): string => p.id;

  accessLabel(p: Person): 'Ops Admin' | 'Ops Operator' | 'Portal Admin' | 'Portal Operator' | 'Portal User' | 'Contact' {
    // Ops access takes precedence. ADMIN → Ops Admin; anything else (OPERATOR, USER, null)
    // defensively falls through to Ops Operator as the lowest ops tier.
    if (p.hasOpsAccess) {
      return p.userType === 'ADMIN' ? 'Ops Admin' : 'Ops Operator';
    }
    // Portal access without ops access: ADMIN → Portal Admin, OPERATOR → Portal Operator, USER/null → Portal User.
    if (p.hasPortalAccess) {
      if (p.userType === 'ADMIN') return 'Portal Admin';
      if (p.userType === 'OPERATOR') return 'Portal Operator';
      return 'Portal User';
    }
    return 'Contact';
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.personService.getPeople(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(p => this.people.set(p));
  }

  openAddDialog(): void {
    this.editing.set(null);
    this.showDialog.set(true);
  }

  openEditDialog(person: Person): void {
    this.editing.set(person);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }

  deletePerson(person: Person): void {
    const message = person.hasPortalAccess
      ? `Deactivate ${person.name}? They will lose portal access.`
      : `Delete ${person.name}? This cannot be undone. If they are a follower on tickets, deletion will fail.`;
    if (!confirm(message)) return;
    this.personService.deletePerson(person.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Person deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
      });
  }
}
