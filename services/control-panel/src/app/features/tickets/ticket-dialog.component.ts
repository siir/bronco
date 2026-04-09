import { Component, inject, input, output, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TicketService } from '../../core/services/ticket.service.js';
import { ClientService, Client } from '../../core/services/client.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-ticket-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      @if (!clientId()) {
        <app-form-field label="Client">
          <app-select
            [value]="selectedClientId"
            [options]="clientOptions()"
            (valueChange)="selectedClientId = $event" />
        </app-form-field>
      }

      <app-form-field label="Subject">
        <app-text-input
          [value]="subject"
          placeholder="Ticket subject..."
          (valueChange)="subject = $event" />
      </app-form-field>

      <app-form-field label="Description">
        <app-textarea
          [value]="description"
          placeholder="Optional description..."
          [rows]="4"
          (valueChange)="description = $event" />
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
      <app-bronco-button variant="primary" [disabled]="!canSave()" (click)="save()">Create</app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class TicketDialogComponent implements OnInit {
  private ticketService = inject(TicketService);
  private clientService = inject(ClientService);
  private toast = inject(ToastService);

  clientId = input<string>('');
  created = output<{ id: string }>();
  cancelled = output<void>();

  clientOptions = signal<Array<{ value: string; label: string }>>([
    { value: '', label: 'Select client...' },
  ]);
  selectedClientId = '';
  subject = '';
  description = '';
  priority = 'MEDIUM';
  category = '';

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
    if (!this.clientId()) {
      this.clientService.getClients().subscribe(clients => {
        this.clientOptions.set([
          { value: '', label: 'Select client...' },
          ...clients.map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
        ]);
      });
    } else {
      this.selectedClientId = this.clientId();
    }
  }

  canSave(): boolean {
    const cid = this.clientId() || this.selectedClientId;
    return !!cid && !!this.subject.trim();
  }

  save(): void {
    const cid = this.clientId() || this.selectedClientId;
    this.ticketService.createTicket({
      clientId: cid,
      subject: this.subject,
      description: this.description || undefined,
      priority: this.priority,
      source: 'MANUAL',
      category: this.category || undefined,
    }).subscribe({
      next: (ticket) => {
        this.toast.success('Ticket created');
        this.created.emit({ id: ticket.id });
      },
      error: (err) => this.toast.error(err.error?.message ?? 'Failed to create ticket'),
    });
  }
}
