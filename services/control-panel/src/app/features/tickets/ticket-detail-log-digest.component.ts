import { Component, input, output } from '@angular/core';
import { BroncoButtonComponent, IconComponent } from '../../shared/components/index.js';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe.js';
import { type LogSummary } from '../../core/services/log-summary.service.js';

@Component({
  selector: 'app-ticket-detail-log-digest',
  standalone: true,
  imports: [BroncoButtonComponent, IconComponent, MarkdownPipe],
  template: `
    <div class="digest-toolbar">
      <app-bronco-button
        variant="secondary"
        size="sm"
        [disabled]="generating()"
        (click)="generate.emit()"
        ariaLabel="Summarize recent logs">
        @if (generating()) {
          <span class="spinner" aria-hidden="true"></span> Summarizing...
        } @else {
          <app-icon name="sparkles" size="sm" /> Summarize Recent Logs
        }
      </app-bronco-button>
    </div>

    @if (generating()) {
      <div class="indeterminate-bar"><span class="indeterminate-track"></span></div>
    }

    @for (ls of summaries(); track ls.id) {
      <div class="log-summary-entry">
        <div class="log-summary-header">
          <span class="log-summary-time">
            {{ formatTime(ls.windowStart) }} — {{ formatTime(ls.windowEnd) }}
          </span>
          <span class="log-summary-count" [attr.title]="ls.logCount + ' log entries'">
            {{ ls.logCount }} logs
          </span>
        </div>
        <div class="log-summary-text" [innerHTML]="cleanSummary(ls.summary) | markdown"></div>
        <div class="log-summary-services">
          @for (svc of ls.services; track svc) {
            <span class="service-chip">{{ svc }}</span>
          }
        </div>
      </div>
    } @empty {
      <p class="empty">No log summaries yet. Click the button above to generate one.</p>
    }
  `,
  styles: [`
    :host {
      display: block;
      font-family: var(--font-primary);
      color: var(--text-primary);
    }
    .digest-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .log-summary-entry {
      padding: 12px 0;
      border-bottom: 1px solid var(--border-light);
    }
    .log-summary-entry:last-child { border-bottom: none; }
    .log-summary-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .log-summary-time { font-size: 12px; color: var(--text-tertiary); }
    .log-summary-count {
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-muted);
      padding: 2px 8px;
      border-radius: var(--radius-pill);
    }
    .log-summary-text {
      margin: 4px 0 8px;
      line-height: 1.5;
      color: var(--text-primary);
      font-size: 14px;
    }
    .log-summary-services { display: flex; gap: 4px; flex-wrap: wrap; }
    .service-chip {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: var(--radius-pill);
      background: var(--color-info-subtle);
      color: var(--color-info);
    }
    .empty {
      color: var(--text-tertiary);
      padding: 16px;
      text-align: center;
    }
    .spinner {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid var(--border-medium);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .indeterminate-bar {
      position: relative;
      height: 3px;
      background: var(--bg-muted);
      border-radius: var(--radius-sm);
      overflow: hidden;
      margin-bottom: 8px;
    }
    .indeterminate-track {
      position: absolute;
      left: -40%;
      width: 40%;
      height: 100%;
      background: var(--accent);
      animation: indeterminate 1.4s ease-in-out infinite;
    }
    @keyframes indeterminate {
      0% { left: -40%; }
      100% { left: 100%; }
    }
  `],
})
export class TicketDetailLogDigestComponent {
  summaries = input.required<LogSummary[]>();
  generating = input<boolean>(false);

  generate = output<void>();

  /** Strip markdown-fenced JSON wrapper from older AI responses */
  cleanSummary(raw: string): string {
    const stripped = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    try {
      const parsed = JSON.parse(stripped) as Record<string, unknown>;
      return typeof parsed['summary'] === 'string' ? parsed['summary'] : stripped;
    } catch {
      return stripped;
    }
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: true, hour: 'numeric', minute: '2-digit' });
  }
}
