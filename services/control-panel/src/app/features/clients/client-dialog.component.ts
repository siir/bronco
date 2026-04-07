import { Component, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { ClientService } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-client-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
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

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name || !shortCode">Create</button>
    </div>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; } .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }`],
})
export class ClientDialogComponent {
  private clientService = inject(ClientService);
  private toast = inject(ToastService);

  created = output<boolean>();
  cancelled = output<void>();

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
        this.created.emit(true);
      },
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to create client');
      },
    });
  }
}
