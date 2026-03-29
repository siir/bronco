import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
  ],
  template: `
    <h2 mat-dialog-title>Reject Analysis</h2>
    <mat-dialog-content>
      <p>Provide a reason for rejecting this analysis. This will be used as context to avoid suggesting similar improvements in the future.</p>
      <mat-form-field class="full-width">
        <mat-label>Rejection Reason</mat-label>
        <textarea matInput [(ngModel)]="reason" rows="4" placeholder="e.g., Not applicable to our setup, already handled by..."></textarea>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="warn" [disabled]="!reason.trim()" (click)="submit()">Reject</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width {
      width: 100%;
    }
  `],
})
export class RejectDialogComponent {
  private dialogRef = inject(MatDialogRef<RejectDialogComponent>);
  reason = '';

  submit(): void {
    if (this.reason.trim()) {
      this.dialogRef.close(this.reason.trim());
    }
  }
}
