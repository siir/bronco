import { Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InvoiceService } from '../../core/services/invoice.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-generate-invoice-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Period Start">
        <app-text-input
          [value]="periodStart"
          type="date"
          (valueChange)="periodStart = $event" />
      </app-form-field>
      <app-form-field label="Period End">
        <app-text-input
          [value]="periodEnd"
          type="date"
          (valueChange)="periodEnd = $event" />
      </app-form-field>
      <label class="checkbox-label">
        <input type="checkbox" class="form-checkbox" [(ngModel)]="finalize">
        Mark as Final
      </label>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!periodStart || !periodEnd || generating" (click)="generate()">
        {{ generating ? 'Generating...' : 'Generate' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-primary); cursor: pointer; }
    .form-checkbox { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent); }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class GenerateInvoiceDialogComponent {
  private invoiceService = inject(InvoiceService);
  private toast = inject(ToastService);

  clientId = input.required<string>();

  generated = output<boolean>();
  cancelled = output<void>();

  periodStart = '';
  periodEnd = '';
  finalize = false;
  generating = false;

  generate(): void {
    this.generating = true;
    this.invoiceService.generateInvoice(this.clientId(), {
      periodStart: this.periodStart,
      periodEnd: this.periodEnd,
      finalize: this.finalize,
    }).subscribe({
      next: () => {
        this.generating = false;
        this.toast.info('Invoice generated');
        this.generated.emit(true);
      },
      error: (err) => {
        this.generating = false;
        this.toast.error(err.error?.error ?? 'Generation failed');
      },
    });
  }
}
