import { Component, input, signal } from '@angular/core';
import { BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-ticket-detail-details',
  standalone: true,
  imports: [BroncoButtonComponent],
  template: `
    @if (description()) {
      <p class="description">{{ truncatedDescription() }}</p>
      @if ((description() ?? '').length > 300) {
        <app-bronco-button variant="ghost" size="sm" (click)="toggleExpanded()">
          {{ expanded() ? 'Show less' : 'Show more' }}
        </app-bronco-button>
      }
    }
    @if (systemName()) { <p class="meta-line"><strong>System:</strong> {{ systemName() }}</p> }
    @if (clientName()) { <p class="meta-line"><strong>Client:</strong> {{ clientName() }}</p> }
  `,
  styles: [`
    :host {
      display: block;
      color: var(--text-primary);
      font-family: var(--font-primary);
      font-size: 14px;
    }
    .description {
      white-space: pre-wrap;
      line-height: 1.5;
      margin: 0 0 8px;
      color: var(--text-primary);
    }
    .meta-line {
      margin: 4px 0;
      color: var(--text-secondary);
      font-size: 13px;
    }
    .meta-line strong {
      color: var(--text-primary);
      font-weight: 600;
    }
  `],
})
export class TicketDetailDetailsComponent {
  description = input<string | null>(null);
  systemName = input<string | null>(null);
  clientName = input<string | null>(null);

  expanded = signal(false);

  truncatedDescription(): string {
    const desc = this.description() ?? '';
    if (this.expanded() || desc.length <= 300) return desc;
    return desc.slice(0, 300) + '...';
  }

  toggleExpanded(): void {
    this.expanded.update(v => !v);
  }
}
