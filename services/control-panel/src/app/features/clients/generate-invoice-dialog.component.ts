import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar } from '@angular/material/snack-bar';
import { InvoiceService } from '../../core/services/invoice.service';

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
  private snackBar = inject(MatSnackBar);

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
        this.snackBar.open('Invoice generated', 'OK', { duration: 3000 });
        this.dialogRef.close(true);
      },
      error: (err) => {
        this.generating = false;
        this.snackBar.open(err.error?.error ?? 'Generation failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }
}
