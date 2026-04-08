import { Component, inject, input, output } from '@angular/core';
import { FormFieldComponent } from './form-field.component';

let standaloneSelectCounter = 0;

@Component({
  selector: 'app-select',
  standalone: true,
  template: `
    <select
      class="select-input"
      [id]="resolvedId()"
      [value]="value()"
      [disabled]="disabled()"
      (change)="onChange($event)">
      @if (placeholder()) {
        <option value="" disabled>{{ placeholder() }}</option>
      }
      @for (opt of options(); track opt.value) {
        <option [value]="opt.value">{{ opt.label }}</option>
      }
    </select>
  `,
  styles: [`
    .select-input {
      width: 100%;
      box-sizing: border-box;
      appearance: none;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 32px 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 400;
      color: var(--text-primary);
      cursor: pointer;
      transition: border-color 120ms ease, box-shadow 120ms ease;
      outline: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
    }

    .select-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring, rgba(0, 113, 227, 0.15));
    }

    .select-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `],
})
export class SelectComponent {
  private parentFormField = inject(FormFieldComponent, { optional: true, skipSelf: true });
  private fallbackId = `select-${++standaloneSelectCounter}`;

  value = input<string>('');
  options = input.required<Array<{ value: string; label: string }>>();
  placeholder = input<string>('Select...');
  disabled = input<boolean>(false);

  valueChange = output<string>();

  resolvedId(): string {
    return this.parentFormField?.inputId() ?? this.fallbackId;
  }

  onChange(event: Event): void {
    this.valueChange.emit((event.target as HTMLSelectElement).value);
  }
}
