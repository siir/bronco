import { Component, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormFieldComponent, TextInputComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-backfill-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, BroncoButtonComponent],
  template: `
    <p>Fetch commits from GitHub and generate release notes for a range of commits.</p>
    <div class="form-grid">
      <app-form-field label="From SHA (base)">
        <app-text-input
          [value]="fromSha"
          placeholder="e.g. abc1234"
          (valueChange)="fromSha = $event" />
      </app-form-field>
      <app-form-field label="To SHA / branch">
        <app-text-input
          [value]="toSha"
          placeholder="e.g. def5678 or master"
          (valueChange)="toSha = $event" />
      </app-form-field>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!fromSha.trim() || !toSha.trim()" (click)="confirm()">Sync</app-bronco-button>
    </div>
  `,
  styles: [`
    p { color: var(--text-secondary); font-size: 14px; margin-top: 0; }
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class BackfillDialogComponent {
  submitted = output<{ fromSha: string; toSha?: string }>();
  cancelled = output<void>();

  fromSha = '';
  toSha = 'master';

  confirm(): void {
    this.submitted.emit({
      fromSha: this.fromSha.trim(),
      toSha: this.toSha.trim(),
    });
  }
}
