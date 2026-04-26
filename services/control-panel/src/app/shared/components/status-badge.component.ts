import { Component, computed, input } from '@angular/core';

export type StatusBadgeValue =
  | 'new'
  | 'open'
  | 'in_progress'
  | 'waiting'
  | 'analyzing'
  | 'resolved'
  | 'closed';

@Component({
  selector: 'app-status-badge',
  standalone: true,
  template: `
    <span class="status-badge">
      <span [class]="'status-dot dot-' + normalizedStatus()"></span>
      <span class="status-label">{{ displayLabel() }}</span>
    </span>
  `,
  styles: [`
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

    .dot-new { background: var(--color-info); }
    .dot-open { background: var(--color-info); }
    .dot-in_progress { background: var(--color-warning); }
    .dot-waiting { background: var(--color-warning); }
    .dot-analyzing { background: var(--accent); }
    .dot-resolved { background: var(--color-success); }
    .dot-closed { background: var(--text-tertiary); }

    .status-label {
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
    }
  `],
})
export class StatusBadgeComponent {
  // Accept any string so callers passing the raw API enum (e.g. 'WAITING')
  // don't need to lowercase or cast at the call site.
  status = input.required<StatusBadgeValue | string>();

  /** Lowercased status for use in dot-* class lookup. */
  normalizedStatus = computed(() => (this.status() ?? '').toLowerCase());

  displayLabel = computed(() => {
    const labels: Record<string, string> = {
      new: 'New',
      open: 'Open',
      in_progress: 'In Progress',
      waiting: 'Waiting',
      analyzing: 'Analyzing',
      resolved: 'Resolved',
      closed: 'Closed',
    };
    const key = this.normalizedStatus();
    return labels[key] ?? this.status();
  });
}
