import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PromptService, PromptKeyword } from '../../core/services/prompt.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

const CATEGORIES = ['TICKET', 'EMAIL', 'DEVOPS', 'CODE', 'DATABASE', 'GENERAL'];

@Component({
  selector: 'app-keyword-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Token" [hint]="!isEdit ? 'Used as {{token}} in prompts' : ''">
        <app-text-input
          [value]="token"
          [readonly]="isEdit"
          placeholder="e.g. ticketSubject"
          (valueChange)="token = $event" />
      </app-form-field>

      <app-form-field label="Label">
        <app-text-input
          [value]="label"
          (valueChange)="label = $event" />
      </app-form-field>

      <app-form-field label="Description">
        <app-textarea
          [value]="description"
          [rows]="2"
          (valueChange)="description = $event" />
      </app-form-field>

      <app-form-field label="Sample Value" hint="Used in preview when no runtime value is available">
        <app-textarea
          [value]="sampleValue"
          [rows]="2"
          (valueChange)="sampleValue = $event" />
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
      <app-bronco-button variant="primary" [disabled]="!canSave()" (click)="save()">
        {{ isEdit ? 'Update' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
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
  categories = CATEGORIES;

  categoryOptions = CATEGORIES.map(c => ({ value: c, label: c }));

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
