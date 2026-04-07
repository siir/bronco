import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { PromptService, PromptKeyword } from '../../core/services/prompt.service';
import { ToastService } from '../../core/services/toast.service';

interface DialogData {
  keyword?: PromptKeyword;
}

const CATEGORIES = ['TICKET', 'EMAIL', 'DEVOPS', 'CODE', 'DATABASE', 'GENERAL'];

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Edit' : 'Add' }} Keyword</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Token</mat-label>
        <input matInput [(ngModel)]="token" [readonly]="isEdit" required placeholder="e.g. ticketSubject">
        @if (!isEdit) {
          <mat-hint>Used as {{ tokenHint }} in prompts</mat-hint>
        }
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Label</mat-label>
        <input matInput [(ngModel)]="label" required>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Description</mat-label>
        <textarea matInput [(ngModel)]="description" rows="2" required></textarea>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Sample Value</mat-label>
        <textarea matInput [(ngModel)]="sampleValue" rows="2"></textarea>
        <mat-hint>Used in preview when no runtime value is available</mat-hint>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Category</mat-label>
        <mat-select [(ngModel)]="category" required>
          @for (c of categories; track c) {
            <mat-option [value]="c">{{ c }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; }`],
})
export class KeywordDialogComponent {
  private dialogRef = inject(MatDialogRef<KeywordDialogComponent>);
  data: DialogData = inject(MAT_DIALOG_DATA);
  private promptService = inject(PromptService);
  private toast = inject(ToastService);

  isEdit = !!this.data.keyword;
  token = this.data.keyword?.token ?? '';
  label = this.data.keyword?.label ?? '';
  description = this.data.keyword?.description ?? '';
  sampleValue = this.data.keyword?.sampleValue ?? '';
  category = this.data.keyword?.category ?? 'GENERAL';
  tokenHint = '{{token}}';
  categories = CATEGORIES;

  canSave(): boolean {
    return !!this.token.trim() && !!this.label.trim() && !!this.description.trim() && !!this.category;
  }

  save(): void {
    if (this.isEdit) {
      this.promptService.updateKeyword(this.data.keyword!.id, {
        label: this.label,
        description: this.description,
        sampleValue: this.sampleValue || null,
        category: this.category,
      }).subscribe({
        next: (result) => {
          this.toast.success('Keyword updated');
          this.dialogRef.close(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to update keyword'),
      });
    } else {
      this.promptService.createKeyword({
        token: this.token,
        label: this.label,
        description: this.description,
        sampleValue: this.sampleValue || undefined,
        category: this.category,
      }).subscribe({
        next: (result) => {
          this.toast.success('Keyword created');
          this.dialogRef.close(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to create keyword'),
      });
    }
  }
}
