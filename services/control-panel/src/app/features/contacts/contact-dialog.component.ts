import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { ContactService } from '../../core/services/contact.service';
import { Contact } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-contact-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCheckboxModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="form.name" required>
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Email</mat-label>
      <input matInput type="email" [(ngModel)]="form.email" required>
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Phone</mat-label>
      <input matInput [(ngModel)]="form.phone">
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Role</mat-label>
      <input matInput [(ngModel)]="form.role" placeholder="e.g. DBA, Developer, Manager">
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Slack User ID</mat-label>
      <input matInput [(ngModel)]="form.slackUserId" placeholder="U0123456789">
      <mat-hint>Used to link Slack messages to this contact</mat-hint>
    </mat-form-field>
    <mat-checkbox [(ngModel)]="form.isPrimary">Primary contact</mat-checkbox>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!form.name || !form.email">{{ isEdit ? 'Save' : 'Create' }}</button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
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
