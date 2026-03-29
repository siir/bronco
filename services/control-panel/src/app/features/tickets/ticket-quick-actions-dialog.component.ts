import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TicketService, Ticket } from '../../core/services/ticket.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Quick Actions — {{ data.ticket.subject }}</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Status</mat-label>
        <mat-select [(ngModel)]="status">
          <mat-option value="OPEN">Open</mat-option>
          <mat-option value="IN_PROGRESS">In Progress</mat-option>
          <mat-option value="WAITING">Waiting</mat-option>
          <mat-option value="RESOLVED">Resolved</mat-option>
          <mat-option value="CLOSED">Closed</mat-option>
        </mat-select>
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
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!hasChanges()">Save</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
  `],
})
export class TicketQuickActionsDialogComponent {
  private dialogRef = inject(MatDialogRef<TicketQuickActionsDialogComponent>);
  data: { ticket: Ticket } = inject(MAT_DIALOG_DATA);
  private ticketService = inject(TicketService);
  private snackBar = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  status = this.data.ticket.status;
  priority = this.data.ticket.priority;
  category = this.data.ticket.category ?? '';

  hasChanges(): boolean {
    return (
      this.status !== this.data.ticket.status ||
      this.priority !== this.data.ticket.priority ||
      (this.category || null) !== (this.data.ticket.category || null)
    );
  }

  save(): void {
    const patch: Record<string, string | null | undefined> = {};
    if (this.status !== this.data.ticket.status) patch['status'] = this.status;
    if (this.priority !== this.data.ticket.priority) patch['priority'] = this.priority;
    if ((this.category || null) !== (this.data.ticket.category || null)) {
      patch['category'] = this.category === '' ? null : this.category;
    }

    this.ticketService.updateTicket(this.data.ticket.id, patch as Partial<Ticket>).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (updated) => {
        this.snackBar.open('Ticket updated', 'OK', { duration: 3000 });
        this.dialogRef.close(updated);
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Failed to update ticket', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
}
