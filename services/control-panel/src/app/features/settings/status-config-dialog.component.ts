import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  SettingsService,
  TicketStatusConfig,
} from '../../core/services/settings.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-status-config-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    FormFieldComponent,
    TextInputComponent,
    TextareaComponent,
    SelectComponent,
    BroncoButtonComponent,
  ],
  template: `
    <div class="form-grid">
      @if (isCreate) {
        <app-form-field label="Value" hint="Must match a valid TicketStatus enum value">
          <app-text-input [value]="value" placeholder="e.g. OPEN" (valueChange)="value = $event" />
        </app-form-field>
      }

      <app-form-field label="Display Name">
        <app-text-input [value]="displayName" (valueChange)="displayName = $event" />
      </app-form-field>

      <app-form-field label="Description">
        <app-textarea [value]="description" [rows]="2" (valueChange)="description = $event" />
      </app-form-field>

      <app-form-field label="Color">
        <div class="color-row">
          <app-text-input [value]="color" placeholder="#2196f3" (valueChange)="color = $event" />
          <span class="color-preview" [style.background]="color"></span>
        </div>
      </app-form-field>

      <app-form-field label="Sort Order">
        <app-text-input [value]="'' + sortOrder" type="number" (valueChange)="sortOrder = +$event" />
      </app-form-field>

      <app-form-field label="Status Class" hint="Determines whether tickets with this status are considered active or terminal">
        <app-select [value]="statusClass" [options]="statusClassOptions" (valueChange)="setStatusClass($event)" />
      </app-form-field>

      @if (!isCreate) {
        <label class="checkbox-row">
          <input type="checkbox" [(ngModel)]="isActive">
          <span>Active</span>
        </label>
      }
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!canSave()" (click)="save()">
        {{ isCreate ? 'Create' : 'Update' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .color-row { display: flex; align-items: center; gap: 8px; }
    .color-preview { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); display: inline-block; flex-shrink: 0; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-secondary); cursor: pointer; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class StatusConfigDialogComponent implements OnInit {
  private svc = inject(SettingsService);
  private toast = inject(ToastService);

  config = input<TicketStatusConfig | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  isCreate = true;
  value = '';
  displayName = '';
  description = '';
  color = '#2196f3';
  sortOrder = 0;
  statusClass: 'open' | 'closed' = 'open';
  isActive = true;

  statusClassOptions = [
    { value: 'open', label: 'Open' },
    { value: 'closed', label: 'Closed' },
  ];

  ngOnInit(): void {
    const c = this.config();
    if (c) {
      this.isCreate = false;
      this.value = c.value;
      this.displayName = c.displayName;
      this.description = c.description ?? '';
      this.color = c.color ?? '#2196f3';
      this.sortOrder = c.sortOrder;
      this.statusClass = (c.statusClass as 'open' | 'closed') ?? 'open';
      this.isActive = c.isActive;
    }
  }

  setStatusClass(val: string): void {
    this.statusClass = val as 'open' | 'closed';
  }

  canSave(): boolean {
    if (!this.displayName.trim()) return false;
    if (this.isCreate && !this.value.trim()) return false;
    return true;
  }

  save(): void {
    if (this.isCreate) {
      this.svc
        .createStatus({
          value: this.value.trim(),
          displayName: this.displayName.trim(),
          description: this.description || null,
          color: this.color,
          sortOrder: this.sortOrder,
          statusClass: this.statusClass,
        })
        .subscribe({
          next: () => {
            this.toast.success('Status created');
            this.saved.emit(true);
          },
          error: (err) =>
            this.toast.error(err.error?.error ?? err.error?.message ?? 'Failed to create'),
        });
    } else {
      const c = this.config()!;
      this.svc
        .updateStatus(c.value, {
          displayName: this.displayName.trim(),
          description: this.description.trim() || null,
          color: this.color.trim(),
          sortOrder: this.sortOrder,
          statusClass: this.statusClass,
          isActive: this.isActive,
        })
        .subscribe({
          next: () => {
            this.toast.success('Status updated');
            this.saved.emit(true);
          },
          error: (err) =>
            this.toast.error(err.error?.error ?? err.error?.message ?? 'Failed to update'),
        });
    }
  }
}
