import { Component, input } from '@angular/core';

@Component({
  selector: 'app-priority-pill',
  standalone: true,
  template: `
    <span [class]="'pill pill-' + priority()">{{ priority() }}</span>
  `,
  styles: [`
    .pill {
      display: inline-block;
      padding: 2px 10px;
      border-radius: var(--radius-pill);
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.5;
      white-space: nowrap;
    }

    .pill-CRITICAL {
      color: var(--text-on-accent, #ffffff);
      background: var(--color-error);
    }

    .pill-HIGH {
      color: var(--text-on-accent, #ffffff);
      background: var(--color-warning);
    }

    .pill-MEDIUM {
      color: var(--color-info);
      background: var(--color-info-subtle, rgba(0, 122, 255, 0.08));
      border: 1px solid var(--color-info-border, rgba(0, 122, 255, 0.3));
    }

    .pill-LOW {
      color: var(--text-secondary);
      background: var(--bg-muted);
    }
  `],
})
export class PriorityPillComponent {
  priority = input.required<'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'>();
}
