import { Component, DestroyRef, inject, input, output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TicketService, Ticket } from '../../core/services/ticket.service.js';
import { FormFieldComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-ticket-quick-actions-content',
  standalone: true,
  imports: [FormFieldComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Status">
        <app-select
          [value]="status"
          [options]="statusOptions"
          (valueChange)="status = $event" />
      </app-form-field>

      <app-form-field label="Priority">
        <app-select
          [value]="priority"
          [options]="priorityOptions"
          (valueChange)="priority = $event" />
      </app-form-field>

      <app-form-field label="Category">
        <app-select
          [value]="category"
          [options]="categoryOptions"
          (valueChange)="category = $event" />
      </app-form-field>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!hasChanges()" (click)="save()">Save</app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class TicketQuickActionsDialogComponent {
  private ticketService = inject(TicketService);
  private snackBar = inject(MatSnackBar);
  private destroyRef = inject(DestroyRef);

  ticket = input.required<Ticket>();
  saved = output<Ticket>();
  cancelled = output<void>();

  status = '';
  priority = '';
  category = '';

  statusOptions = [
    { value: 'OPEN', label: 'Open' },
    { value: 'IN_PROGRESS', label: 'In Progress' },
    { value: 'WAITING', label: 'Waiting' },
    { value: 'RESOLVED', label: 'Resolved' },
    { value: 'CLOSED', label: 'Closed' },
  ];

  priorityOptions = [
    { value: 'LOW', label: 'Low' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'HIGH', label: 'High' },
    { value: 'CRITICAL', label: 'Critical' },
  ];

  categoryOptions = [
    { value: '', label: 'None' },
    { value: 'DATABASE_PERF', label: 'Database Perf' },
    { value: 'BUG_FIX', label: 'Bug Fix' },
    { value: 'FEATURE_REQUEST', label: 'Feature Request' },
    { value: 'SCHEMA_CHANGE', label: 'Schema Change' },
    { value: 'CODE_REVIEW', label: 'Code Review' },
    { value: 'ARCHITECTURE', label: 'Architecture' },
    { value: 'GENERAL', label: 'General' },
  ];

  ngOnInit(): void {
    const t = this.ticket();
    this.status = t.status;
    this.priority = t.priority;
    this.category = t.category ?? '';
  }

  hasChanges(): boolean {
    const t = this.ticket();
    return (
      this.status !== t.status ||
      this.priority !== t.priority ||
      (this.category || null) !== (t.category || null)
    );
  }

  save(): void {
    const t = this.ticket();
    const patch: Record<string, string | null | undefined> = {};
    if (this.status !== t.status) patch['status'] = this.status;
    if (this.priority !== t.priority) patch['priority'] = this.priority;
    if ((this.category || null) !== (t.category || null)) {
      patch['category'] = this.category === '' ? null : this.category;
    }

    this.ticketService.updateTicket(t.id, patch as Partial<Ticket>).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (updated) => {
        this.snackBar.open('Ticket updated', 'OK', { duration: 3000 });
        this.saved.emit(updated);
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Failed to update ticket', 'OK', { duration: 5000 }),
    });
  }
}
