import { Component, inject, input, output } from '@angular/core';
import { FormFieldComponent } from './form-field.component.js';

let standaloneTextareaCounter = 0;

@Component({
  selector: 'app-textarea',
  standalone: true,
  template: `
    <textarea
      class="textarea-input"
      [id]="resolvedId()"
      [value]="value()"
      [placeholder]="placeholder()"
      [rows]="rows()"
      [disabled]="disabled()"
      [readOnly]="readonly()"
      (input)="onInput($event)"
    ></textarea>
  `,
  styles: [`
    .textarea-input {
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
      resize: vertical;
    }

    .textarea-input::placeholder {
      color: var(--text-tertiary);
    }

    .textarea-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring);
    }

    .textarea-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    @media (max-width: 767.98px) {
      .textarea-input { font-size: 16px; }
    }
  `],
})
export class TextareaComponent {
  private parentFormField = inject(FormFieldComponent, { optional: true, skipSelf: true });
  private fallbackId = `textarea-${++standaloneTextareaCounter}`;

  value = input<string>('');
  placeholder = input<string>('');
  rows = input<number>(4);
  disabled = input<boolean>(false);
  readonly = input<boolean>(false);

  valueChange = output<string>();

  resolvedId(): string {
    return this.parentFormField?.inputId() ?? this.fallbackId;
  }

  onInput(event: Event): void {
    this.valueChange.emit((event.target as HTMLTextAreaElement).value);
  }
}
