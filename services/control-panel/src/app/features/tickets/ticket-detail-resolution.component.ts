import { Component, input } from '@angular/core';

@Component({
  selector: 'app-ticket-detail-resolution',
  standalone: true,
  template: `
    <p class="summary-text">{{ summary() }}</p>
  `,
  styles: [`
    .summary-text {
      white-space: pre-wrap;
      line-height: 1.6;
      margin: 0;
      color: var(--text-primary);
      font-family: var(--font-primary);
      font-size: 14px;
    }
  `],
})
export class TicketDetailResolutionComponent {
  summary = input.required<string>();
}
