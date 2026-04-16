import { Component, computed, inject, input, output, OnInit, signal } from '@angular/core';
import { ClientService } from '../../core/services/client.service.js';
import { TicketFilterPreset } from '../../core/services/ticket-filter-preset.service.js';
import { FormFieldComponent, SelectComponent, BroncoButtonComponent, IconComponent } from '../../shared/components/index.js';

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
  imports: [FormFieldComponent, SelectComponent, BroncoButtonComponent, IconComponent],
  template: `
    <div class="filter-form">
      <!-- Preset management -->
      <div class="preset-section">
        <span class="section-label">Preset</span>
        <div class="preset-row">
          <app-select
            class="preset-select"
            [value]="selectedPresetId()"
            [options]="presetOptions()"
            (valueChange)="onPresetSelected($event)" />
          <app-bronco-button variant="icon" size="sm" (click)="presetSaveRequested.emit()" title="Save current filters as preset">
            <app-icon name="add" size="sm" />
          </app-bronco-button>
          @if (selectedPresetId()) {
            <app-bronco-button variant="icon" size="sm" (click)="presetDeleteRequested.emit()" title="Delete preset">
              <app-icon name="delete" size="sm" />
            </app-bronco-button>
            <button
              type="button"
              class="default-toggle"
              [class.is-default]="isSelectedPresetDefault()"
              (click)="presetDefaultToggleRequested.emit(!isSelectedPresetDefault())"
              title="Set as default preset">
              {{ isSelectedPresetDefault() ? 'Default' : 'Set default' }}
            </button>
          }
        </div>
      </div>

      <div class="filter-section">
        <span class="section-label">Priority</span>
        <div class="checkbox-group">
          @for (p of priorities; track p.value) {
            <label class="checkbox-item">
              <input
                type="checkbox"
                [checked]="isPrioritySelected(p.value)"
                (change)="togglePriority(p.value); commit()" />
              <span class="checkbox-label">{{ p.label }}</span>
            </label>
          }
        </div>
      </div>

      <app-form-field label="Category">
        <app-select
          [value]="category"
          [options]="categoryOptions"
          (valueChange)="category = $event; commit()" />
      </app-form-field>

      <app-form-field label="Client">
        <app-select
          [value]="clientId"
          [options]="clientOptions()"
          (valueChange)="clientId = $event; commit()" />
      </app-form-field>

      <app-form-field label="Source">
        <app-select
          [value]="source"
          [options]="sourceOptions"
          (valueChange)="source = $event; commit()" />
      </app-form-field>

      <app-form-field label="Analysis Status">
        <app-select
          [value]="analysisStatus"
          [options]="analysisStatusOptions"
          (valueChange)="analysisStatus = $event; commit()" />
      </app-form-field>

      <div class="date-range">
        <app-form-field label="Created From">
          <input
            type="date"
            class="date-input"
            [value]="createdFrom"
            (change)="createdFrom = asInput($event).value; commit()" />
        </app-form-field>
        <app-form-field label="Created To">
          <input
            type="date"
            class="date-input"
            [value]="createdTo"
            (change)="createdTo = asInput($event).value; commit()" />
        </app-form-field>
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancel.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" (click)="close.emit()">OK</app-bronco-button>
    </div>
  `,
  styles: [`
    .filter-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .filter-section,
    .preset-section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .preset-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .preset-select {
      flex: 1;
      min-width: 0;
    }

    .default-toggle {
      background: none;
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      font-family: var(--font-primary);
      font-size: 12px;
      color: var(--text-tertiary);
      cursor: pointer;
      transition: all 120ms ease;
      white-space: nowrap;
    }

    .default-toggle:hover {
      background: var(--bg-hover);
    }

    .default-toggle.is-default {
      background: var(--bg-active);
      color: var(--accent);
      border-color: var(--accent);
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

    @media (max-width: 767.98px) {
      .date-range { grid-template-columns: 1fr; }
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
      box-shadow: 0 0 0 2px var(--focus-ring);
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
  presets = input<TicketFilterPreset[]>([]);
  selectedPresetId = input<string>('');

  apply = output<AdvancedFilters>();
  cancel = output<void>();
  close = output<void>();
  presetSelected = output<string>();
  presetSaveRequested = output<void>();
  presetDeleteRequested = output<void>();
  presetDefaultToggleRequested = output<boolean>();

  clientOptions = signal<Array<{ value: string; label: string }>>([]);

  presetOptions = computed(() => {
    const options = this.presets().map(p => ({
      value: p.id,
      label: p.name + (p.isDefault ? ' \u2605' : ''),
    }));
    return [{ value: '', label: '— No preset —' }, ...options];
  });

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

    // Seed local form state from the parent's current filters once on open.
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

  isSelectedPresetDefault(): boolean {
    const id = this.selectedPresetId();
    return this.presets().find(p => p.id === id)?.isDefault ?? false;
  }

  onPresetSelected(id: string): void {
    this.presetSelected.emit(id);
    // Also reflect the preset's filters in this dialog's local form state so
    // the user can see what they picked. Presets only carry status/category/
    // client — we leave priority/source/analysisStatus/dates untouched so any
    // edits the user already made are preserved.
    if (id) {
      const preset = this.presets().find(p => p.id === id);
      if (preset) {
        this.category = preset.categoryFilter ?? '';
        this.clientId = preset.clientIdFilter ?? '';
      }
    }
  }

  /** Build the current form state and emit it to the parent for live apply. */
  commit(): void {
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

  asInput(event: Event): HTMLInputElement {
    return event.target as HTMLInputElement;
  }
}
