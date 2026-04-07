import { Component, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormFieldComponent, TextareaComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-reject-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextareaComponent, BroncoButtonComponent],
  template: `
    <p>Provide a reason for rejecting this analysis. This will be used as context to avoid suggesting similar improvements in the future.</p>
    <div class="form-grid">
      <app-form-field label="Rejection Reason">
        <app-textarea
          [value]="reason"
          [rows]="4"
          placeholder="e.g., Not applicable to our setup, already handled by..."
          (valueChange)="reason = $event" />
      </app-form-field>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="destructive" [disabled]="!reason.trim()" (click)="submit()">Reject</app-bronco-button>
    </div>
  `,
  styles: [`
    p { color: var(--text-secondary, #666); font-size: 14px; margin-top: 0; }
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
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
