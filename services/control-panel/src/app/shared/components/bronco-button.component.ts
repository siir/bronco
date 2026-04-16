import { Component, ElementRef, inject, input } from '@angular/core';

@Component({
  selector: 'app-bronco-button',
  standalone: true,
  host: { '[class.full-width]': 'fullWidth()' },
  template: `
    <button
      type="button"
      [class]="'btn btn-' + variant() + ' btn-' + size() + (fullWidth() ? ' btn-full-width' : '')"
      [disabled]="disabled()"
      [attr.aria-label]="ariaLabel() || null"
      [attr.aria-expanded]="ariaExpanded() !== null ? ariaExpanded() : null">
      <ng-content />
    </button>
  `,
  styles: [`
    :host { display: inline-block; }
    :host.full-width { display: block; }

    .btn {
      font-family: var(--font-primary);
      font-weight: 500;
      cursor: pointer;
      transition: all 120ms ease;
      border: none;
      outline: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .btn:disabled {
      opacity: 0.4;
      pointer-events: none;
    }

    /* Variants */
    .btn-primary {
      background: var(--accent);
      color: var(--text-on-accent);
      border-radius: var(--radius-md);
    }
    .btn-primary:hover { opacity: 0.85; }

    .btn-secondary {
      background: var(--bg-card);
      color: var(--text-primary);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-pill);
    }
    .btn-secondary:hover { background: var(--bg-hover); }

    .btn-ghost {
      background: transparent;
      color: var(--text-secondary);
      border-radius: var(--radius-md);
    }
    .btn-ghost:hover { background: var(--bg-hover); }

    .btn-destructive {
      background: var(--color-error);
      color: var(--text-on-accent);
      border-radius: var(--radius-md);
    }
    .btn-destructive:hover { opacity: 0.85; }

    .btn-icon {
      background: transparent;
      color: var(--text-tertiary);
      border-radius: var(--radius-sm);
      padding: 0;
    }
    .btn-icon:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    /* Sizes */
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn-md { padding: 6px 14px; font-size: 13px; }
    .btn-lg { padding: 8px 18px; font-size: 14px; }

    .btn-icon.btn-sm { width: 28px; height: 28px; padding: 0; }
    .btn-icon.btn-md { width: 32px; height: 32px; padding: 0; }
    .btn-icon.btn-lg { width: 36px; height: 36px; padding: 0; }

    .btn-full-width { width: 100%; }
  `],
})
export class BroncoButtonComponent {
  readonly elementRef = inject(ElementRef<HTMLElement>);

  variant = input<'primary' | 'secondary' | 'ghost' | 'destructive' | 'icon'>('secondary');
  size = input<'sm' | 'md' | 'lg'>('md');
  disabled = input<boolean>(false);
  ariaLabel = input<string>('');
  fullWidth = input<boolean>(false);
  ariaExpanded = input<boolean | null>(null);
}
