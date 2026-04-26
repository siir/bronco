import { Component, input, output } from '@angular/core';
import { BroncoButtonComponent, IconComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-ticket-detail-resolution',
  standalone: true,
  imports: [BroncoButtonComponent, IconComponent],
  template: `
    @if (summary(); as s) {
      <p class="summary-text">{{ s }}</p>
    } @else {
      <p class="summary-empty">No resolution summary yet — analysis has not completed or no summary was produced.</p>
    }

    <div class="resolution-actions">
      <app-bronco-button variant="secondary" (click)="reanalyze.emit()" [disabled]="reanalyzing()">
        <app-icon name="refresh" size="sm" /> Re-run Analysis
      </app-bronco-button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .summary-text {
      white-space: pre-wrap;
      line-height: 1.6;
      margin: 0;
      color: var(--text-primary);
      font-family: var(--font-primary);
      font-size: 14px;
    }
    .summary-empty {
      margin: 0;
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 13px;
      font-style: italic;
    }
    .resolution-actions {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
      display: flex;
      justify-content: flex-start;
    }
  `],
})
export class TicketDetailResolutionComponent {
  summary = input<string | null>(null);
  reanalyzing = input<boolean>(false);
  reanalyze = output<void>();
}
