import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Contact } from '../../../../core/services/client.service';
import { ContactService } from '../../../../core/services/contact.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
  IconComponent,
} from '../../../../shared/components/index.js';
import { ContactDialogComponent } from '../../../contacts/contact-dialog.component';

@Component({
  selector: 'app-client-contacts-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    ContactDialogComponent,
    IconComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Contacts</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openAddDialog()">+ Add Contact</app-bronco-button>
      </div>

      <app-data-table
        [data]="contacts()"
        [trackBy]="trackById"
        [rowClickable]="false"
        emptyMessage="No contacts added.">
        <app-data-column key="name" header="Name" [sortable]="false">
          <ng-template #cell let-c>{{ c.name }}</ng-template>
        </app-data-column>
        <app-data-column key="email" header="Email" [sortable]="false">
          <ng-template #cell let-c>{{ c.email }}</ng-template>
        </app-data-column>
        <app-data-column key="role" header="Role" [sortable]="false">
          <ng-template #cell let-c>{{ c.role ?? '-' }}</ng-template>
        </app-data-column>
        <app-data-column key="isPrimary" header="Primary" [sortable]="false" width="80px">
          <ng-template #cell let-c>
            @if (c.isPrimary) {
              <app-icon name="star" size="sm" class="primary-star" title="Primary contact" />
            }
          </ng-template>
        </app-data-column>
        <app-data-column key="actions" header="" [sortable]="false" width="100px">
          <ng-template #cell let-c>
            <div class="row-actions">
              <app-bronco-button variant="icon" size="sm" ariaLabel="Edit contact" (click)="openEditDialog(c)"><app-icon name="edit" size="sm" /></app-bronco-button>
              <app-bronco-button variant="icon" size="sm" ariaLabel="Delete contact" (click)="deleteContact(c.id)"><app-icon name="delete" size="sm" /></app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        [title]="editing() ? 'Edit Contact' : 'Add Contact'"
        maxWidth="500px"
        (openChange)="showDialog.set(false)">
        <app-contact-dialog-content
          [clientId]="clientId()"
          [contact]="editing() ?? undefined"
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
      font-size: 18px;
      line-height: 1;
    }

    .row-actions {
      display: inline-flex;
      gap: 4px;
    }
  `],
})
export class ClientContactsTabComponent implements OnInit {
  clientId = input.required<string>();

  private contactService = inject(ContactService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  contacts = signal<Contact[]>([]);
  showDialog = signal(false);
  editing = signal<Contact | null>(null);

  trackById = (c: Contact): string => c.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.contactService.getContacts(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(c => this.contacts.set(c));
  }

  openAddDialog(): void {
    this.editing.set(null);
    this.showDialog.set(true);
  }

  openEditDialog(contact: Contact): void {
    this.editing.set(contact);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }

  deleteContact(id: string): void {
    this.contactService.deleteContact(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Contact deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
      });
  }
}
