import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ContactService } from '../../core/services/contact.service';
import { Contact } from '../../core/services/client.service';

export interface ContactDialogData {
  clientId: string;
  contact?: Contact;
}

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Edit Contact' : 'Add Contact' }}</h2>
    <mat-dialog-content>
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
      <mat-checkbox [(ngModel)]="form.isPrimary">Primary contact</mat-checkbox>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!form.name || !form.email">{{ isEdit ? 'Save' : 'Create' }}</button>
    </mat-dialog-actions>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; }`],
})
export class ContactDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<ContactDialogComponent>);
  private data: ContactDialogData = inject(MAT_DIALOG_DATA);
  private contactService = inject(ContactService);
  private snackBar = inject(MatSnackBar);

  isEdit = false;
  form = { name: '', email: '', phone: '', role: '', isPrimary: false };

  ngOnInit(): void {
    if (this.data.contact) {
      this.isEdit = true;
      this.form = {
        name: this.data.contact.name,
        email: this.data.contact.email,
        phone: this.data.contact.phone ?? '',
        role: this.data.contact.role ?? '',
        isPrimary: this.data.contact.isPrimary,
      };
    }
  }

  save(): void {
    if (this.isEdit) {
      this.contactService.updateContact(this.data.contact!.id, {
        name: this.form.name,
        email: this.form.email,
        phone: this.form.phone === '' ? null : this.form.phone,
        role: this.form.role === '' ? null : this.form.role,
        isPrimary: this.form.isPrimary,
      }).subscribe({
        next: () => {
          this.snackBar.open('Contact updated', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.error ?? 'Update failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    } else {
      this.contactService.createContact({
        clientId: this.data.clientId,
        name: this.form.name,
        email: this.form.email,
        phone: this.form.phone || undefined,
        role: this.form.role || undefined,
        isPrimary: this.form.isPrimary,
      }).subscribe({
        next: () => {
          this.snackBar.open('Contact created', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.error ?? 'Failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    }
  }
}
