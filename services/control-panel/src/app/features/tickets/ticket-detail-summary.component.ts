import { Component, input } from '@angular/core';

@Component({
  selector: 'app-ticket-detail-summary',
  standalone: true,
  template: `
    <p class="blurb-text">{{ emailBlurb() }}</p>
  `,
  styles: [`
    .blurb-text {
      line-height: 1.5;
      margin: 0;
      color: var(--text-primary);
      font-family: var(--font-primary);
      font-size: 14px;
    }
  `],
})
export class TicketDetailSummaryComponent {
  emailBlurb = input.required<string>();
}
