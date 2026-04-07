import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { InvoiceService } from '../../core/services/invoice.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>Generate Invoice</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Period Start</mat-label>
        <input matInput type="date" [(ngModel)]="periodStart" required>
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>Period End</mat-label>
        <input matInput type="date" [(ngModel)]="periodEnd" required>
      </mat-form-field>
      <mat-checkbox [(ngModel)]="finalize">Mark as Final</mat-checkbox>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" [disabled]="!periodStart || !periodEnd || generating" (click)="generate()">
        {{ generating ? 'Generating...' : 'Generate' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; }`],
})
export class GenerateInvoiceDialogComponent {
  private dialogRef = inject(MatDialogRef<GenerateInvoiceDialogComponent>);
  private data: { clientId: string } = inject(MAT_DIALOG_DATA);
  private invoiceService = inject(InvoiceService);
  private toast = inject(ToastService);

  periodStart = '';
  periodEnd = '';
  finalize = false;
  generating = false;

  generate(): void {
    this.generating = true;
    this.invoiceService.generateInvoice(this.data.clientId, {
      periodStart: this.periodStart,
      periodEnd: this.periodEnd,
      finalize: this.finalize,
    }).subscribe({
      next: () => {
        this.toast.info('Invoice generated');
        this.dialogRef.close(true);
      },
      error: (err) => {
        this.generating = false;
        this.toast.error(err.error?.error ?? 'Generation failed');
      },
    });
  }
}
