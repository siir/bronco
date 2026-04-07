import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { ClientService } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>New Client</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Name</mat-label>
        <input matInput [(ngModel)]="name" required>
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>Short Code</mat-label>
        <input matInput [(ngModel)]="shortCode" required placeholder="e.g. ACME">
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>Domain Mappings</mat-label>
        <input matInput [(ngModel)]="domainMappingsStr" placeholder="e.g. acme.com, acme.org">
        <mat-hint>Comma-separated email domains to auto-route to this client</mat-hint>
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>Notes</mat-label>
        <textarea matInput [(ngModel)]="notes" rows="3"></textarea>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name || !shortCode">Create</button>
    </mat-dialog-actions>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; }`],
})
export class ClientDialogComponent {
  private dialogRef = inject(MatDialogRef<ClientDialogComponent>);
  private clientService = inject(ClientService);
  private toast = inject(ToastService);

  name = '';
  shortCode = '';
  domainMappingsStr = '';
  notes = '';

  save(): void {
    const domainMappings = this.domainMappingsStr
      ? this.domainMappingsStr.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
      : [];
    this.clientService.createClient({
      name: this.name,
      shortCode: this.shortCode,
      domainMappings,
      notes: this.notes || undefined,
    }).subscribe({
      next: () => {
        this.toast.success('Client created');
        this.dialogRef.close(true);
      },
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to create client');
      },
    });
  }
}
