import { Component, inject, input, output } from '@angular/core';
import { FormFieldComponent } from './form-field.component';

let standaloneInputCounter = 0;

@Component({
  selector: 'app-text-input',
  standalone: true,
  template: `
    <input
      class="text-input"
      [id]="resolvedId()"
      [type]="type()"
      [value]="value()"
      [placeholder]="placeholder()"
      [disabled]="disabled()"
      [readOnly]="readonly()"
      (input)="onInput($event)"
    />
  `,
  styles: [`
    .text-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 400;
      color: var(--text-primary);
      transition: border-color 120ms ease, box-shadow 120ms ease;
      outline: none;
    }

    .text-input::placeholder {
      color: var(--text-tertiary);
    }

    .text-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring, rgba(0, 113, 227, 0.15));
    }

    .text-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `],
})
export class TextInputComponent {
  private parentFormField = inject(FormFieldComponent, { optional: true, skipSelf: true });
  private fallbackId = `text-input-${++standaloneInputCounter}`;

  value = input<string>('');
  placeholder = input<string>('');
  type = input<string>('text');
  disabled = input<boolean>(false);
  readonly = input<boolean>(false);

  valueChange = output<string>();

  resolvedId(): string {
    return this.parentFormField?.inputId() ?? this.fallbackId;
  }

  onInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement).value);
  }
}
