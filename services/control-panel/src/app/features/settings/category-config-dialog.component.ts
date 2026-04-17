import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  SettingsService,
  TicketCategoryConfig,
} from '../../core/services/settings.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, TextareaComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-category-config-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    FormFieldComponent,
    TextInputComponent,
    TextareaComponent,
    BroncoButtonComponent,
  ],
  template: `
    <div class="form-grid">
      @if (isCreate) {
        <app-form-field label="Value" hint="Must match a valid TicketCategory enum value">
          <app-text-input [value]="value" placeholder="e.g. DATABASE_PERF" (valueChange)="value = $event" />
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
        <app-text-input [value]="'' + sortOrder" type="number" (valueChange)="sortOrder = parseSortOrder($event)" />
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
export class CategoryConfigDialogComponent implements OnInit {
  private svc = inject(SettingsService);
  private toast = inject(ToastService);

  config = input<TicketCategoryConfig | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  isCreate = true;
  value = '';
  displayName = '';
  description = '';
  color = '#2196f3';
  sortOrder = 0;
  isActive = true;

  ngOnInit(): void {
    const c = this.config();
    if (c) {
      this.isCreate = false;
      this.value = c.value;
      this.displayName = c.displayName;
      this.description = c.description ?? '';
      this.color = c.color ?? '#2196f3';
      this.sortOrder = c.sortOrder;
      this.isActive = c.isActive;
    }
  }

  parseSortOrder(val: string): number {
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? 0 : Math.max(0, n);
  }

  canSave(): boolean {
    if (!this.displayName.trim()) return false;
    if (this.isCreate && !this.value.trim()) return false;
    return true;
  }

  save(): void {
    if (this.isCreate) {
      this.svc
        .createCategory({
          value: this.value.trim(),
          displayName: this.displayName.trim(),
          description: this.description || null,
          color: this.color,
          sortOrder: this.sortOrder,
        })
        .subscribe({
          next: () => {
            this.toast.success('Category created');
            this.saved.emit(true);
          },
          error: (err) =>
            this.toast.error(err.error?.error ?? err.error?.message ?? 'Failed to create'),
        });
    } else {
      const c = this.config()!;
      this.svc
        .updateCategory(c.value, {
          displayName: this.displayName,
          description: this.description || null,
          color: this.color,
          sortOrder: this.sortOrder,
          isActive: this.isActive,
        })
        .subscribe({
          next: () => {
            this.toast.success('Category updated');
            this.saved.emit(true);
          },
          error: (err) =>
            this.toast.error(err.error?.error ?? err.error?.message ?? 'Failed to update'),
        });
    }
  }
}
