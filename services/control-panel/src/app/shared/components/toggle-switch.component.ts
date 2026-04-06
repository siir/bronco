import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-toggle-switch',
  standalone: true,
  template: `
    <label class="toggle-wrapper" [class.disabled]="disabled()">
      <button
        type="button"
        class="toggle-track"
        role="switch"
        [attr.aria-checked]="checked()"
        [attr.aria-label]="label() || 'Toggle'"
        [class.active]="checked()"
        [disabled]="disabled()"
        (click)="toggle()">
        <span class="toggle-thumb"></span>
      </button>
      @if (label()) {
        <span class="toggle-label">{{ label() }}</span>
      }
    </label>
  `,
  styles: [`
    .toggle-wrapper {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }

    .toggle-wrapper.disabled {
      opacity: 0.4;
      pointer-events: none;
    }

    .toggle-track {
      width: 36px;
      height: 20px;
      border-radius: 10px;
      background: var(--border-medium);
      border: none;
      padding: 2px;
      cursor: pointer;
      position: relative;
      transition: background 120ms ease;
      display: flex;
      align-items: center;
    }

    .toggle-track.active {
      background: var(--accent);
    }

    .toggle-thumb {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      display: block;
      transition: transform 120ms ease;
    }

    .toggle-track.active .toggle-thumb {
      transform: translateX(16px);
    }

    .toggle-label {
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-secondary);
    }
  `],
})
export class ToggleSwitchComponent {
  checked = input<boolean>(false);
  disabled = input<boolean>(false);
  label = input<string>('');

  checkedChange = output<boolean>();

  toggle(): void {
    this.checkedChange.emit(!this.checked());
  }
}
