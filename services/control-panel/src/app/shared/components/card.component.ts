import { Component, input } from '@angular/core';
import { NgClass } from '@angular/common';

@Component({
  selector: 'app-card',
  standalone: true,
  imports: [NgClass],
  template: `
    <div [ngClass]="['card', 'pad-' + padding(), !shadow() ? 'no-shadow' : '']">
      <ng-content />
    </div>
  `,
  styles: [`
    .card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
    }

    .card.no-shadow {
      box-shadow: none;
      border: 1px solid var(--border-light);
    }

    .pad-none { padding: 0; }
    .pad-sm { padding: 12px; }
    .pad-md { padding: 20px; }
    .pad-lg { padding: 24px; }
  `],
})
export class CardComponent {
  padding = input<'none' | 'sm' | 'md' | 'lg'>('md');
  shadow = input<boolean>(true);
}
