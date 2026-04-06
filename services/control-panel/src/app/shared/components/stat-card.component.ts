import { Component, input } from '@angular/core';

@Component({
  selector: 'app-stat-card',
  standalone: true,
  template: `
    <div class="stat-card">
      <div class="stat-label">{{ label() }}</div>
      <div class="stat-value">{{ value() }}</div>
      @if (change()) {
        <div [class]="'stat-change change-' + changeType()">{{ change() }}</div>
      }
    </div>
  `,
  styles: [`
    .stat-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      padding: 20px;
      box-shadow: var(--shadow-card);
    }

    .stat-label {
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-tertiary);
    }

    .stat-value {
      font-family: var(--font-primary);
      font-size: 32px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.8px;
      line-height: 1.1;
    }

    .stat-change {
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 400;
      margin-top: 6px;
    }

    .change-positive { color: var(--color-success); }
    .change-negative { color: var(--color-error); }
    .change-neutral { color: var(--text-tertiary); }
  `],
})
export class StatCardComponent {
  label = input.required<string>();
  value = input.required<string>();
  change = input('');
  changeType = input<'positive' | 'negative' | 'neutral'>('neutral');
}
