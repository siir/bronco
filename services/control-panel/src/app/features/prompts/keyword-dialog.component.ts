import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { PromptService, PromptKeyword } from '../../core/services/prompt.service';
import { ToastService } from '../../core/services/toast.service';

const CATEGORIES = ['TICKET', 'EMAIL', 'DEVOPS', 'CODE', 'DATABASE', 'GENERAL'];

@Component({
  selector: 'app-keyword-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
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

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; } .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }`],
})
export class KeywordDialogComponent implements OnInit {
  private promptService = inject(PromptService);
  private toast = inject(ToastService);

  keyword = input<PromptKeyword>();

  saved = output<PromptKeyword>();
  cancelled = output<void>();

  isEdit = false;
  token = '';
  label = '';
  description = '';
  sampleValue = '';
  category = 'GENERAL';
  tokenHint = '{{token}}';
  categories = CATEGORIES;

  ngOnInit(): void {
    const kw = this.keyword();
    if (kw) {
      this.isEdit = true;
      this.token = kw.token ?? '';
      this.label = kw.label ?? '';
      this.description = kw.description ?? '';
      this.sampleValue = kw.sampleValue ?? '';
      this.category = kw.category ?? 'GENERAL';
    }
  }

  canSave(): boolean {
    return !!this.token.trim() && !!this.label.trim() && !!this.description.trim() && !!this.category;
  }

  save(): void {
    if (this.isEdit) {
      this.promptService.updateKeyword(this.keyword()!.id, {
        label: this.label,
        description: this.description,
        sampleValue: this.sampleValue || null,
        category: this.category,
      }).subscribe({
        next: (result) => {
          this.toast.success('Keyword updated');
          this.saved.emit(result);
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
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to create keyword'),
      });
    }
  }
}
