import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { AiUsageService, AiModelCost } from '../../core/services/ai-usage.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-model-cost-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatCheckboxModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Provider</mat-label>
      <mat-select [(ngModel)]="provider" [disabled]="isEdit" required>
        @for (p of catalogProviders; track p) {
          <mat-option [value]="p">{{ p }}</mat-option>
        }
      </mat-select>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Model ID</mat-label>
      <input matInput [(ngModel)]="model" [readonly]="isEdit" required placeholder="e.g. claude-sonnet-4-6">
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Display Name</mat-label>
      <input matInput [(ngModel)]="displayName" placeholder="e.g. Claude Sonnet 4.6">
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Input Cost ($/1M tokens)</mat-label>
      <input matInput type="number" [(ngModel)]="inputCostPer1m" required min="0" step="0.01">
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Output Cost ($/1M tokens)</mat-label>
      <input matInput type="number" [(ngModel)]="outputCostPer1m" required min="0" step="0.01">
    </mat-form-field>

    <mat-checkbox [(ngModel)]="isCustomCost">
      Custom cost (protect from AI updates)
    </mat-checkbox>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!provider || !model">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ModelCostDialogComponent implements OnInit {
  private aiUsageService = inject(AiUsageService);
  private toast = inject(ToastService);

  cost = input<AiModelCost | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;
  provider = '';
  model = '';
  displayName = '';
  inputCostPer1m = 0;
  outputCostPer1m = 0;
  isCustomCost = true;

  catalogProviders: string[] = [];

  ngOnInit(): void {
    const c = this.cost();
    if (c) {
      this.isEdit = true;
      this.provider = c.provider;
      this.model = c.model;
      this.displayName = c.displayName ?? '';
      this.inputCostPer1m = c.inputCostPer1m;
      this.outputCostPer1m = c.outputCostPer1m;
      this.isCustomCost = c.isCustomCost;
    }

    this.aiUsageService.getCatalog().subscribe(catalog => {
      this.catalogProviders = catalog.providers.map(p => p.provider);
      if (this.provider && !this.catalogProviders.includes(this.provider)) {
        this.catalogProviders.push(this.provider);
      }
      if (this.catalogProviders.length === 0) {
        this.catalogProviders = ['CLAUDE', 'OPENAI', 'LOCAL', 'GROK', 'GOOGLE'];
      }
    });
  }

  save(): void {
    this.aiUsageService.upsertCost({
      provider: this.provider,
      model: this.model,
      displayName: this.displayName || undefined,
      inputCostPer1m: this.inputCostPer1m,
      outputCostPer1m: this.outputCostPer1m,
      isCustomCost: this.isCustomCost,
    }).subscribe({
      next: () => {
        this.toast.success(this.isEdit ? 'Cost updated' : 'Model cost added');
        this.saved.emit(true);
      },
      error: (err) => this.toast.error(err.error?.message ?? 'Failed to save'),
    });
  }
}
