import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TicketService } from '../../core/services/ticket.service';
import { ClientService, Client } from '../../core/services/client.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>Create Ticket</h2>
    <mat-dialog-content>
      @if (!data.clientId) {
        <mat-form-field class="full-width">
          <mat-label>Client</mat-label>
          <mat-select [(ngModel)]="clientId" required>
            @for (c of clients; track c.id) {
              <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }

      <mat-form-field class="full-width">
        <mat-label>Subject</mat-label>
        <input matInput [(ngModel)]="subject" required>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Description</mat-label>
        <textarea matInput [(ngModel)]="description" rows="4"></textarea>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Priority</mat-label>
        <mat-select [(ngModel)]="priority">
          <mat-option value="LOW">Low</mat-option>
          <mat-option value="MEDIUM">Medium</mat-option>
          <mat-option value="HIGH">High</mat-option>
          <mat-option value="CRITICAL">Critical</mat-option>
        </mat-select>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Category</mat-label>
        <mat-select [(ngModel)]="category">
          <mat-option value="">None</mat-option>
          <mat-option value="DATABASE_PERF">Database Perf</mat-option>
          <mat-option value="BUG_FIX">Bug Fix</mat-option>
          <mat-option value="FEATURE_REQUEST">Feature Request</mat-option>
          <mat-option value="SCHEMA_CHANGE">Schema Change</mat-option>
          <mat-option value="CODE_REVIEW">Code Review</mat-option>
          <mat-option value="ARCHITECTURE">Architecture</mat-option>
          <mat-option value="GENERAL">General</mat-option>
        </mat-select>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!clientId || !subject">Create</button>
    </mat-dialog-actions>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; }`],
})
export class TicketDialogComponent {
  private dialogRef = inject(MatDialogRef<TicketDialogComponent>);
  data: { clientId?: string } = inject(MAT_DIALOG_DATA);
  private ticketService = inject(TicketService);
  private clientService = inject(ClientService);
  private snackBar = inject(MatSnackBar);

  clientId = this.data.clientId ?? '';
  subject = '';
  description = '';
  priority = 'MEDIUM';
  category = '';
  clients: Client[] = [];

  constructor() {
    if (!this.data.clientId) {
      this.clientService.getClients().subscribe(c => this.clients = c);
    }
  }

  save(): void {
    this.ticketService.createTicket({
      clientId: this.clientId,
      subject: this.subject,
      description: this.description || undefined,
      priority: this.priority,
      source: 'MANUAL',
      category: this.category || undefined,
    }).subscribe({
      next: (ticket) => {
        this.snackBar.open('Ticket created', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
        this.dialogRef.close(ticket);
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Failed to create ticket', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
}
