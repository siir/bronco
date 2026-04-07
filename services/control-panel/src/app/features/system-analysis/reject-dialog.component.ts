import { Component, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-reject-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
  ],
  template: `
    <p>Provide a reason for rejecting this analysis. This will be used as context to avoid suggesting similar improvements in the future.</p>
    <mat-form-field class="full-width">
      <mat-label>Rejection Reason</mat-label>
      <textarea matInput [(ngModel)]="reason" rows="4" placeholder="e.g., Not applicable to our setup, already handled by..."></textarea>
    </mat-form-field>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="warn" [disabled]="!reason.trim()" (click)="submit()">Reject</button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class RejectDialogComponent {
  rejected = output<string>();
  cancelled = output<void>();

  reason = '';

  submit(): void {
    if (this.reason.trim()) {
      this.rejected.emit(this.reason.trim());
    }
  }
}
