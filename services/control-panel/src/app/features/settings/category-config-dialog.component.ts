import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  SettingsService,
  TicketCategoryConfig,
} from '../../core/services/settings.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-category-config-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatCheckboxModule,
  ],
  template: `
    @if (isCreate) {
      <mat-form-field class="full-width">
        <mat-label>Value</mat-label>
        <input matInput [(ngModel)]="value" placeholder="e.g. DATABASE_PERF" required>
        <mat-hint>Must match a valid TicketCategory enum value</mat-hint>
      </mat-form-field>
    }

    <mat-form-field class="full-width">
      <mat-label>Display Name</mat-label>
      <input matInput [(ngModel)]="displayName">
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Description</mat-label>
      <textarea matInput [(ngModel)]="description" rows="2"></textarea>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Color</mat-label>
      <input matInput [(ngModel)]="color" placeholder="#2196f3">
      <div matSuffix class="color-preview" [style.background]="color"></div>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Sort Order</mat-label>
      <input matInput type="number" [(ngModel)]="sortOrder" min="0">
    </mat-form-field>

    @if (!isCreate) {
      <mat-checkbox [(ngModel)]="isActive" class="active-checkbox">
        Active
      </mat-checkbox>
    }

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isCreate ? 'Create' : 'Update' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .active-checkbox { display: block; margin: 8px 0 16px; }
    .color-preview {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: 1px solid #ccc;
      display: inline-block;
    }
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
