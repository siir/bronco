import { Component, input } from '@angular/core';

@Component({
  selector: 'app-category-chip',
  standalone: true,
  template: `
    <span class="chip">{{ category() }}</span>
  `,
  styles: [`
    .chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
      font-size: 11px;
      font-weight: 600;
      background: var(--bg-muted);
      color: var(--text-secondary);
      white-space: nowrap;
    }
  `],
})
export class CategoryChipComponent {
  category = input.required<string>();
}
