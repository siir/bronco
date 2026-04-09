import { Component, input } from '@angular/core';
import { IconComponent } from './icon.component.js';
import type { IconName } from './icon-registry.js';

export type StatCardIconVariant = 'accent' | 'success' | 'warning' | 'error' | 'neutral';

@Component({
  selector: 'app-stat-card',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="stat-card">
      @if (icon()) {
        <div [class]="'stat-icon variant-' + iconVariant()">
          <app-icon [name]="icon()!" size="lg" />
        </div>
      }
      <div class="stat-label">{{ label() }}</div>
      <div class="stat-value">{{ value() }}</div>
      @if (change()) {
        <div [class]="'stat-change change-' + changeType()">{{ change() }}</div>
      }
    </div>
  `,
  styles: [`
    .stat-card {
      position: relative;
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      padding: 20px;
      box-shadow: var(--shadow-card);
    }

    .stat-icon {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-md, 8px);
    }

    .variant-accent  { background: color-mix(in srgb, var(--accent) 14%, transparent);        color: var(--accent); }
    .variant-success { background: color-mix(in srgb, var(--color-success) 14%, transparent); color: var(--color-success); }
    .variant-warning { background: color-mix(in srgb, var(--color-warning) 14%, transparent); color: var(--color-warning); }
    .variant-error   { background: color-mix(in srgb, var(--color-error) 14%, transparent);   color: var(--color-error); }
    .variant-neutral { background: color-mix(in srgb, var(--text-tertiary) 14%, transparent); color: var(--text-tertiary); }

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
  icon = input<IconName | null>(null);
  iconVariant = input<StatCardIconVariant>('neutral');
}
