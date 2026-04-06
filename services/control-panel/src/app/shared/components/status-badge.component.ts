import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-status-badge',
  standalone: true,
  template: `
    <span class="status-badge">
      <span class="status-dot" [class]="'dot-' + status()"></span>
      <span class="status-label">{{ displayLabel() }}</span>
    </span>
  `,
  styles: `
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .dot-open { background: var(--color-info); }
    .dot-in_progress { background: var(--color-warning); }
    .dot-analyzing { background: var(--accent); }
    .dot-resolved { background: var(--color-success); }
    .dot-closed { background: var(--text-tertiary); }

    .status-label {
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
    }
  `,
})
export class StatusBadgeComponent {
  status = input.required<'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed'>();

  displayLabel = computed(() => {
    const labels: Record<string, string> = {
      open: 'Open',
      in_progress: 'In Progress',
      analyzing: 'Analyzing',
      resolved: 'Resolved',
      closed: 'Closed',
    };
    return labels[this.status()] ?? this.status();
  });
}
