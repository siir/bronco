import { Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { InvoiceService } from '../../core/services/invoice.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-generate-invoice-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCheckboxModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Period Start</mat-label>
      <input matInput type="date" [(ngModel)]="periodStart" required>
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Period End</mat-label>
      <input matInput type="date" [(ngModel)]="periodEnd" required>
    </mat-form-field>
    <mat-checkbox [(ngModel)]="finalize">Mark as Final</mat-checkbox>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" [disabled]="!periodStart || !periodEnd || generating" (click)="generate()">
        {{ generating ? 'Generating...' : 'Generate' }}
      </button>
    </div>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; } .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }`],
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
