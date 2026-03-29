import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  SettingsService,
  TicketStatusConfig,
} from '../../core/services/settings.service';

export interface StatusConfigDialogData {
  config?: TicketStatusConfig;
}

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatCheckboxModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ isCreate ? 'Create Status' : 'Edit Status: ' + data.config!.value }}</h2>
    <mat-dialog-content>
      @if (isCreate) {
        <mat-form-field class="full-width">
          <mat-label>Value</mat-label>
          <input matInput [(ngModel)]="value" placeholder="e.g. OPEN" required>
          <mat-hint>Must match a valid TicketStatus enum value</mat-hint>
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

      <mat-form-field class="full-width">
        <mat-label>Status Class</mat-label>
        <mat-select [(ngModel)]="statusClass">
          <mat-option value="open">Open</mat-option>
          <mat-option value="closed">Closed</mat-option>
        </mat-select>
        <mat-hint>Determines whether tickets with this status are considered active or terminal</mat-hint>
      </mat-form-field>

      @if (!isCreate) {
        <mat-checkbox [(ngModel)]="isActive" class="active-checkbox">
          Active
        </mat-checkbox>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isCreate ? 'Create' : 'Update' }}
      </button>
    </mat-dialog-actions>
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
  `],
})
export class StatusConfigDialogComponent {
  private dialogRef = inject(MatDialogRef<StatusConfigDialogComponent>);
  data: StatusConfigDialogData = inject(MAT_DIALOG_DATA);
  private svc = inject(SettingsService);
  private snackBar = inject(MatSnackBar);

  isCreate = !this.data.config;

  value = this.data.config?.value ?? '';
  displayName = this.data.config?.displayName ?? '';
  description = this.data.config?.description ?? '';
  color = this.data.config?.color ?? '#2196f3';
  sortOrder = this.data.config?.sortOrder ?? 0;
  statusClass = this.data.config?.statusClass ?? 'open';
  isActive = this.data.config?.isActive ?? true;

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
          statusClass: this.statusClass as 'open' | 'closed',
        })
        .subscribe({
          next: () => {
            this.snackBar.open('Status created', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
            this.dialogRef.close(true);
          },
          error: (err) =>
            this.snackBar.open(
              err.error?.error ?? err.error?.message ?? 'Failed to create',
              'OK',
              { duration: 5000 },
            ),
        });
    } else {
      this.svc
        .updateStatus(this.data.config!.value, {
          displayName: this.displayName,
          description: this.description || null,
          color: this.color,
          sortOrder: this.sortOrder,
          statusClass: this.statusClass as 'open' | 'closed',
          isActive: this.isActive,
        })
        .subscribe({
          next: () => {
            this.snackBar.open('Status updated', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
            this.dialogRef.close(true);
          },
          error: (err) =>
            this.snackBar.open(
              err.error?.error ?? err.error?.message ?? 'Failed to update',
              'OK',
              { duration: 5000 },
            ),
        });
    }
  }
}
