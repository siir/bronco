import { Component, input } from '@angular/core';

@Component({
  selector: 'app-form-field',
  standalone: true,
  template: `
    <label class="form-field" [class.has-error]="error()">
      <span class="field-label">{{ label() }}</span>
      <div class="field-input">
        <ng-content />
      </div>
      @if (error()) {
        <span class="field-error">{{ error() }}</span>
      } @else if (hint()) {
        <span class="field-hint">{{ hint() }}</span>
      }
    </label>
  `,
  styles: [`
    .form-field {
      display: block;
    }

    .field-label {
      display: block;
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }

    .has-error .field-label {
      color: var(--color-error);
    }

    .field-error {
      display: block;
      font-family: var(--font-primary);
      font-size: 12px;
      color: var(--color-error);
      margin-top: 4px;
    }

    .field-hint {
      display: block;
      font-family: var(--font-primary);
      font-size: 12px;
      color: var(--text-tertiary);
      margin-top: 4px;
    }
  `],
})
export class FormFieldComponent {
  label = input.required<string>();
  error = input<string>('');
  hint = input<string>('');
}
