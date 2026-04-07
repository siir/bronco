import { Component, inject, input, output, OnInit, signal } from '@angular/core';
import { ClientService } from '../../core/services/client.service.js';
import { FormFieldComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

export interface AdvancedFilters {
  priority: string;
  category: string;
  clientId: string;
  source: string;
  analysisStatus: string;
  createdFrom: string;
  createdTo: string;
}

export const EMPTY_ADVANCED_FILTERS: AdvancedFilters = {
  priority: '',
  category: '',
  clientId: '',
  source: '',
  analysisStatus: '',
  createdFrom: '',
  createdTo: '',
};

@Component({
  selector: 'app-ticket-filter-dialog',
  standalone: true,
  imports: [FormFieldComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="filter-form">
      <div class="filter-section">
        <span class="section-label">Priority</span>
        <div class="checkbox-group">
          @for (p of priorities; track p.value) {
            <label class="checkbox-item">
              <input
                type="checkbox"
                [checked]="isPrioritySelected(p.value)"
                (change)="togglePriority(p.value)" />
              <span class="checkbox-label">{{ p.label }}</span>
            </label>
          }
        </div>
      </div>

      <app-form-field label="Category">
        <app-select
          [value]="category"
          [options]="categoryOptions"
          placeholder="All categories"
          (valueChange)="category = $event" />
      </app-form-field>

      <app-form-field label="Client">
        <app-select
          [value]="clientId"
          [options]="clientOptions()"
          placeholder="All clients"
          (valueChange)="clientId = $event" />
      </app-form-field>

      <app-form-field label="Source">
        <app-select
          [value]="source"
          [options]="sourceOptions"
          placeholder="All sources"
          (valueChange)="source = $event" />
      </app-form-field>

      <app-form-field label="Analysis Status">
        <app-select
          [value]="analysisStatus"
          [options]="analysisStatusOptions"
          placeholder="All statuses"
          (valueChange)="analysisStatus = $event" />
      </app-form-field>

      <div class="date-range">
        <app-form-field label="Created From">
          <input
            type="date"
            class="date-input"
            [value]="createdFrom"
            (change)="createdFrom = asInput($event).value" />
        </app-form-field>
        <app-form-field label="Created To">
          <input
            type="date"
            class="date-input"
            [value]="createdTo"
            (change)="createdTo = asInput($event).value" />
        </app-form-field>
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="onReset()">Reset</app-bronco-button>
      <app-bronco-button variant="primary" (click)="onApply()">Apply</app-bronco-button>
    </div>
  `,
  styles: [`
    .filter-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .filter-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .section-label {
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .checkbox-group {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }

    .checkbox-item {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-primary);
    }

    .checkbox-item input[type="checkbox"] {
      accent-color: var(--accent);
      width: 16px;
      height: 16px;
      cursor: pointer;
    }

    .date-range {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    .date-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    .date-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring, rgba(0, 113, 227, 0.15));
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  `],
})
export class TicketFilterDialogComponent implements OnInit {
  private clientService = inject(ClientService);

  currentFilters = input<AdvancedFilters>(EMPTY_ADVANCED_FILTERS);
  apply = output<AdvancedFilters>();
  reset = output<void>();

  clientOptions = signal<Array<{ value: string; label: string }>>([]);

  selectedPriorities: Set<string> = new Set();
  category = '';
  clientId = '';
  source = '';
  analysisStatus = '';
  createdFrom = '';
  createdTo = '';

  priorities = [
    { value: 'CRITICAL', label: 'Critical' },
    { value: 'HIGH', label: 'High' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'LOW', label: 'Low' },
  ];

  categoryOptions = [
    { value: '', label: 'All' },
    { value: 'DATABASE_PERF', label: 'Database Perf' },
    { value: 'BUG_FIX', label: 'Bug Fix' },
    { value: 'FEATURE_REQUEST', label: 'Feature Request' },
    { value: 'SCHEMA_CHANGE', label: 'Schema Change' },
    { value: 'CODE_REVIEW', label: 'Code Review' },
    { value: 'ARCHITECTURE', label: 'Architecture' },
    { value: 'GENERAL', label: 'General' },
  ];

  sourceOptions = [
    { value: '', label: 'All' },
    { value: 'MANUAL', label: 'Manual' },
    { value: 'EMAIL', label: 'Email' },
    { value: 'AZURE_DEVOPS', label: 'Azure DevOps' },
    { value: 'AI_DETECTED', label: 'AI Detected' },
    { value: 'SCHEDULED', label: 'Scheduled' },
  ];

  analysisStatusOptions = [
    { value: '', label: 'All' },
    { value: 'PENDING', label: 'Pending' },
    { value: 'IN_PROGRESS', label: 'In Progress' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'FAILED', label: 'Failed' },
    { value: 'SKIPPED', label: 'Skipped' },
  ];

  ngOnInit(): void {
    this.clientService.getClients().subscribe(clients => {
      this.clientOptions.set([
        { value: '', label: 'All' },
        ...clients.map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
      ]);
    });

    const f = this.currentFilters();
    if (f.priority) {
      f.priority.split(',').forEach(p => this.selectedPriorities.add(p));
    }
    this.category = f.category;
    this.clientId = f.clientId;
    this.source = f.source;
    this.analysisStatus = f.analysisStatus;
    this.createdFrom = f.createdFrom;
    this.createdTo = f.createdTo;
  }

  isPrioritySelected(value: string): boolean {
    return this.selectedPriorities.has(value);
  }

  togglePriority(value: string): void {
    if (this.selectedPriorities.has(value)) {
      this.selectedPriorities.delete(value);
    } else {
      this.selectedPriorities.add(value);
    }
  }

  onApply(): void {
    this.apply.emit({
      priority: Array.from(this.selectedPriorities).join(','),
      category: this.category,
      clientId: this.clientId,
      source: this.source,
      analysisStatus: this.analysisStatus,
      createdFrom: this.createdFrom,
      createdTo: this.createdTo,
    });
  }

  onReset(): void {
    this.reset.emit();
  }

  asInput(event: Event): HTMLInputElement {
    return event.target as HTMLInputElement;
  }
}
