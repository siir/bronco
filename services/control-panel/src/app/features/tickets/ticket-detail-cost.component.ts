import { Component, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { CardComponent, BroncoButtonComponent, IconComponent } from '../../shared/components/index.js';
import { type TicketCostResponse } from '../../core/services/ai-usage.service.js';

@Component({
  selector: 'app-ticket-detail-cost',
  standalone: true,
  imports: [DatePipe, DecimalPipe, CardComponent, BroncoButtonComponent, IconComponent],
  template: `
    @if (cost(); as c) {
      @if (c.callCount > 0) {
        <app-card padding="md" class="cost-card">
          <div class="card-title-row">
            <app-icon name="bolt" size="sm" class="card-title-icon" aria-hidden="true" />
            <h3 class="card-title">AI Cost</h3>
          </div>
          <div class="cost-summary">
            <div class="cost-item">
              <span class="cost-label">Total Cost</span>
              <span class="cost-value">\${{ c.totalCostUsd | number:'1.4-4' }}</span>
            </div>
            <div class="cost-item">
              <span class="cost-label">AI Calls</span>
              <span class="cost-value">{{ c.callCount | number }}</span>
            </div>
            <div class="cost-item">
              <span class="cost-label">Input Tokens</span>
              <span class="cost-value">{{ c.totalInputTokens | number }}</span>
            </div>
            <div class="cost-item">
              <span class="cost-label">Output Tokens</span>
              <span class="cost-value">{{ c.totalOutputTokens | number }}</span>
            </div>
          </div>

          @if (c.breakdown.length > 0) {
            <app-bronco-button variant="ghost" size="sm" (click)="toggleDetails()">
              {{ detailsExpanded() ? 'Hide details' : 'Show details' }}
              <app-icon [name]="detailsExpanded() ? 'chevron-up' : 'chevron-down'" size="xs" />
            </app-bronco-button>
          }

          @if (detailsExpanded()) {
            <div class="cost-breakdown">
              @for (item of c.breakdown; track item.provider + ':' + item.model) {
                <div class="breakdown-group">
                  <div class="breakdown-header">
                    <span class="provider-chip provider-{{ item.provider.toLowerCase() }}">{{ item.provider }}</span>
                    <code class="model-name">{{ item.model }}</code>
                    <span class="breakdown-stats">
                      {{ item.callCount }} calls &middot;
                      \${{ item.totalCostUsd | number:'1.4-4' }}
                    </span>
                  </div>
                  @if (item.calls && item.calls.length > 0) {
                    <div class="call-list">
                      @for (call of item.calls; track call.id) {
                        <div class="call-row">
                          <span class="call-task">{{ call.taskType }}</span>
                          <span class="call-tokens">{{ call.inputTokens | number }}in / {{ call.outputTokens | number }}out</span>
                          @if (call.costUsd != null) {
                            <span class="call-cost">\${{ call.costUsd | number:'1.4-4' }}</span>
                          }
                          @if (call.durationMs != null) {
                            <span class="call-duration">{{ call.durationMs }}ms</span>
                          }
                          <span class="call-time">{{ call.createdAt | date:'shortTime' }}</span>
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </div>
          }
        </app-card>
      } @else {
        <p class="empty">No AI calls recorded for this ticket.</p>
      }
    }
  `,
  styles: [`
    :host {
      display: block;
      margin-bottom: 16px;
      font-family: var(--font-primary);
    }
    .card-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .card-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .card-title-icon { color: var(--accent); }
    .cost-summary {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
    }
    .cost-item {
      display: flex;
      flex-direction: column;
    }
    .cost-label {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-tertiary);
      letter-spacing: 0.5px;
    }
    .cost-value {
      font-size: 20px;
      font-weight: 600;
      font-family: var(--font-primary);
      color: var(--text-primary);
    }
    .cost-breakdown {
      margin-top: 12px;
      border-top: 1px solid var(--border-light);
      padding-top: 12px;
    }
    .breakdown-group { margin-bottom: 12px; }
    .breakdown-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .breakdown-stats {
      font-size: 12px;
      color: var(--text-tertiary);
      margin-left: auto;
    }
    .call-list { padding-left: 16px; }
    .call-row {
      display: flex;
      gap: 12px;
      align-items: center;
      font-size: 12px;
      padding: 2px 0;
      color: var(--text-secondary);
    }
    .call-task {
      font-weight: 500;
      color: var(--text-primary);
      min-width: 140px;
    }
    .call-tokens { color: var(--text-tertiary); }
    .call-cost { color: var(--color-success); font-weight: 500; }
    .call-duration { color: var(--text-tertiary); }
    .call-time { color: var(--text-tertiary); margin-left: auto; }

    /* Mobile: call rows overflow under 375px. Stack vertically and let
       each chip wrap naturally instead of fighting for horizontal space. */
    @media (max-width: 767.98px) {
      .call-row {
        flex-wrap: wrap;
        gap: 4px 8px;
      }
      .call-task {
        min-width: 0;
        width: 100%;
      }
      .call-time {
        margin-left: 0;
      }
    }

    .provider-chip {
      font-weight: 600;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      background: var(--bg-muted);
      color: var(--text-primary);
    }
    .provider-local { background: var(--color-success-subtle); color: var(--color-success); }
    .provider-claude { background: var(--color-purple-subtle); color: var(--color-purple); }
    .provider-openai { background: var(--color-info-subtle); color: var(--color-info); }
    .provider-grok { background: var(--color-warning-subtle); color: var(--color-warning); }
    .provider-google { background: var(--color-success-subtle); color: var(--color-success); }
    .model-name {
      font-size: 12px;
      background: var(--bg-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      color: var(--text-primary);
    }
    .empty {
      color: var(--text-tertiary);
      padding: 16px;
      text-align: center;
    }
  `],
})
export class TicketDetailCostComponent {
  cost = input<TicketCostResponse | null>(null);
  detailsExpanded = signal(false);

  toggleDetails(): void {
    this.detailsExpanded.update(v => !v);
  }
}
