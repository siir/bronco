import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ContactService } from '../../core/services/contact.service';
import { Contact } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-contact-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input [value]="form.name" (valueChange)="form.name = $event" />
      </app-form-field>
      <app-form-field label="Email">
        <app-text-input [value]="form.email" type="email" (valueChange)="form.email = $event" />
      </app-form-field>
      <app-form-field label="Phone">
        <app-text-input [value]="form.phone" (valueChange)="form.phone = $event" />
      </app-form-field>
      <app-form-field label="Role">
        <app-text-input [value]="form.role" placeholder="e.g. DBA, Developer, Manager" (valueChange)="form.role = $event" />
      </app-form-field>
      <app-form-field label="Slack User ID" hint="Used to link Slack messages to this contact">
        <app-text-input [value]="form.slackUserId" placeholder="U0123456789" (valueChange)="form.slackUserId = $event" />
      </app-form-field>
      <label class="checkbox-row">
        <input type="checkbox" [(ngModel)]="form.isPrimary">
        <span>Primary contact</span>
      </label>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!form.name || !form.email" (click)="save()">
        {{ isEdit ? 'Save' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-secondary); cursor: pointer; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ContactDialogComponent implements OnInit {
  private contactService = inject(ContactService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  contact = input<Contact | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;
  form = { name: '', email: '', phone: '', role: '', slackUserId: '', isPrimary: false };

  ngOnInit(): void {
    const c = this.contact();
    if (c) {
      this.isEdit = true;
      this.form = {
        name: c.name,
        email: c.email,
        phone: c.phone ?? '',
        role: c.role ?? '',
        slackUserId: c.slackUserId ?? '',
        isPrimary: c.isPrimary,
      };
    }
  }

  save(): void {
    const c = this.contact();
    if (this.isEdit && c) {
      this.contactService.updateContact(c.id, {
        name: this.form.name,
        email: this.form.email,
        phone: this.form.phone === '' ? null : this.form.phone,
        role: this.form.role === '' ? null : this.form.role,
        slackUserId: this.form.slackUserId === '' ? null : this.form.slackUserId,
        isPrimary: this.form.isPrimary,
      }).subscribe({
        next: () => {
          this.toast.success('Contact updated');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Update failed'),
      });
    } else {
      this.contactService.createContact({
        clientId: this.clientId(),
        name: this.form.name,
        email: this.form.email,
        phone: this.form.phone || undefined,
        role: this.form.role || undefined,
        slackUserId: this.form.slackUserId || undefined,
        isPrimary: this.form.isPrimary,
      }).subscribe({
        next: () => {
          this.toast.success('Contact created');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Failed'),
      });
    }
  }
}
