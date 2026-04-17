import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiUsageService, AiModelCost } from '../../core/services/ai-usage.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-model-cost-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Provider">
        <app-select
          [value]="provider"
          [options]="providerOptions"
          [disabled]="isEdit"
          (valueChange)="provider = $event" />
      </app-form-field>

      <app-form-field label="Model ID">
        <app-text-input
          [value]="model"
          [disabled]="isEdit"
          placeholder="e.g. claude-sonnet-4-6"
          (valueChange)="model = $event" />
      </app-form-field>

      <app-form-field label="Display Name">
        <app-text-input
          [value]="displayName"
          placeholder="e.g. Claude Sonnet 4.6"
          (valueChange)="displayName = $event" />
      </app-form-field>

      <app-form-field label="Input Cost ($/1M tokens)">
        <app-text-input
          [value]="'' + inputCostPer1m"
          type="number"
          (valueChange)="inputCostPer1m = parseCost($event)" />
      </app-form-field>

      <app-form-field label="Output Cost ($/1M tokens)">
        <app-text-input
          [value]="'' + outputCostPer1m"
          type="number"
          (valueChange)="outputCostPer1m = parseCost($event)" />
      </app-form-field>

      <label class="checkbox-row">
        <input type="checkbox" [(ngModel)]="isCustomCost">
        <span>Custom cost (protect from AI updates)</span>
      </label>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!provider || !model" (click)="save()">
        {{ isEdit ? 'Update' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-secondary); cursor: pointer; }
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

  providerOptions: Array<{ value: string; label: string }> = [];

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
      let providers = catalog.providers.map(p => p.provider);
      if (this.provider && !providers.includes(this.provider)) {
        providers.push(this.provider);
      }
      if (providers.length === 0) {
        providers = ['CLAUDE', 'OPENAI', 'LOCAL', 'GROK', 'GOOGLE'];
      }
      this.providerOptions = providers.map(p => ({ value: p, label: p }));
    });
  }

  parseCost(val: string): number {
    const n = parseFloat(val);
    return Number.isNaN(n) ? 0 : n;
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
