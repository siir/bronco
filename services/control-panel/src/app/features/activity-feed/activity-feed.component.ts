import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LogSummaryService, type LogSummary, type LogSummaryType, type AttentionLevel } from '../../core/services/log-summary.service';
import { BroncoButtonComponent, SelectComponent, PaginatorComponent, type PaginatorPageEvent } from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

const TYPE_META: Record<LogSummaryType, { label: string; color: string }> = {
  TICKET: { label: 'Ticket', color: 'var(--accent)' },
  ORPHAN: { label: 'Orphaned Ticket', color: 'var(--color-warning)' },
  SERVICE: { label: 'Service Activity', color: 'var(--text-tertiary)' },
  UNCATEGORIZED: { label: 'Uncategorized', color: 'var(--text-tertiary)' },
};

@Component({
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    RouterLink,
    BroncoButtonComponent,
    SelectComponent,
    PaginatorComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1 class="page-title">Activity Feed</h1>
        <div class="header-actions">
          <app-bronco-button variant="primary" (click)="generateAll()" [disabled]="generating()">
            {{ generating() ? 'Summarizing...' : 'Summarize All' }}
          </app-bronco-button>
          <app-bronco-button variant="secondary" (click)="load()">
            Refresh
          </app-bronco-button>
        </div>
      </div>

      @if (generating()) {
        <div class="loading-state">Generating summaries...</div>
      }

      <div class="filters">
        <app-select
          [value]="typeFilter"
          [options]="typeFilterOptions"
          [placeholder]="''"
          (valueChange)="typeFilter = $event; resetAndLoad()">
        </app-select>
      </div>

      <div class="feed">
        @for (s of summaries(); track s.id) {
          <div [class]="'summary-card ' + attentionClass(s.attentionLevel)" [style.border-left-color]="typeColor(s.summaryType)">
            <div class="summary-header">
              <div class="summary-meta">
                @if (s.ticketId) {
                  <a [routerLink]="['/tickets', s.ticketId]" class="ticket-link">
                    Ticket {{ s.ticketId.slice(0, 8) }}...
                  </a>
                } @else {
                  <span class="type-label">{{ typeLabel(s.summaryType) }}</span>
                }
                <span class="time-range">
                  {{ formatTime(s.windowStart) }} — {{ formatTime(s.windowEnd) }}
                </span>
              </div>
              <div class="summary-stats">
                @if (s.attentionLevel === 'MEDIUM' || s.attentionLevel === 'HIGH') {
                  <span class="attention-badge" [ngClass]="'attention-' + s.attentionLevel.toLowerCase()">
                    {{ s.attentionLevel === 'HIGH' ? 'Needs Attention' : 'Review' }}
                  </span>
                }
                <span class="log-count" [title]="s.logCount + ' log entries'">
                  {{ s.logCount }} logs
                </span>
              </div>
            </div>
            <p class="summary-text">{{ s.summary }}</p>
            <div class="service-chips">
              @for (svc of s.services; track svc) {
                <span class="service-chip">{{ svc }}</span>
              }
            </div>
          </div>
        } @empty {
          @if (!generating()) {
            <p class="empty">No log summaries yet. Click "Summarize All" to generate summaries from existing logs.</p>
          }
        }
      </div>

      <app-paginator
        [length]="total()"
        [pageSize]="pageSize"
        [pageIndex]="pageIndex"
        [pageSizeOptions]="[20, 50, 100]"
        (page)="onPage($event)" />
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .header-actions { display: flex; gap: 8px; }

    .loading-state {
      font-family: var(--font-primary); font-size: 13px; color: var(--accent);
      padding: 8px 0; margin-bottom: 8px;
    }

    .filters { margin-bottom: 16px; }
    .filters app-select { min-width: 200px; }

    .feed { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }

    .summary-card {
      background: var(--bg-card); border-radius: var(--radius-lg); padding: 16px;
      box-shadow: var(--shadow-card); border-left: 4px solid var(--accent);
      transition: background-color 0.2s;
    }
    .attention-high {
      background-color: rgba(255, 59, 48, 0.04);
      border-left-color: var(--color-error) !important;
    }
    .attention-medium {
      background-color: rgba(255, 149, 0, 0.04);
      border-left-color: var(--color-warning) !important;
    }

    .attention-badge {
      font-family: var(--font-primary); font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: var(--radius-pill); margin-right: 8px;
    }
    .attention-badge.attention-high {
      background: rgba(255, 59, 48, 0.1); color: var(--color-error);
    }
    .attention-badge.attention-medium {
      background: rgba(255, 149, 0, 0.1); color: var(--color-warning);
    }

    .summary-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .summary-meta { display: flex; flex-direction: column; flex: 1; }
    .ticket-link {
      color: var(--accent-link); text-decoration: none; font-family: var(--font-primary); font-weight: 500;
    }
    .ticket-link:hover { text-decoration: underline; }
    .type-label { font-family: var(--font-primary); font-weight: 500; color: var(--text-tertiary); }
    .time-range { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); }
    .summary-stats { text-align: right; }
    .log-count {
      font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary);
      background: var(--bg-muted); padding: 2px 8px; border-radius: var(--radius-pill);
    }
    .summary-text {
      margin: 8px 0; line-height: 1.5; font-family: var(--font-primary);
      font-size: 14px; color: var(--text-secondary);
    }
    .attention-high .summary-text { color: var(--color-error); }
    .attention-medium .summary-text { color: var(--color-warning); }

    .service-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .service-chip {
      font-family: var(--font-primary); font-size: 11px; padding: 2px 8px;
      border-radius: var(--radius-pill); background: var(--color-info-subtle);
      color: var(--accent);
    }
    .empty {
      text-align: center; color: var(--text-tertiary); padding: 48px 0;
      font-family: var(--font-primary);
    }
  `],
})
export class ActivityFeedComponent implements OnInit, OnDestroy {
  private logSummaryService = inject(LogSummaryService);
  private toast = inject(ToastService);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  summaries = signal<LogSummary[]>([]);
  total = signal(0);
  generating = signal(false);

  typeFilter = 'all';
  pageSize = 20;
  pageIndex = 0;

  typeFilterOptions = [
    { value: 'all', label: 'All Summaries' },
    { value: 'ticket', label: 'Ticket Summaries' },
    { value: 'orphan', label: 'Orphan Summaries' },
    { value: 'service', label: 'Service Summaries' },
    { value: 'uncategorized', label: 'Uncategorized' },
  ];

  ngOnInit(): void {
    this.load();
    this.refreshInterval = setInterval(() => this.load(), 30000);
  }

  ngOnDestroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  load(): void {
    this.logSummaryService.getSummaries({
      type: this.typeFilter !== 'all'
        ? this.typeFilter as 'ticket' | 'orphan' | 'service' | 'uncategorized'
        : undefined,
      limit: this.pageSize,
      offset: this.pageIndex * this.pageSize,
    }).subscribe(res => {
      this.summaries.set(res.summaries);
      this.total.set(res.total);
    });
  }

  resetAndLoad(): void {
    this.pageIndex = 0;
    this.load();
  }

  onPage(event: PaginatorPageEvent): void {
    this.pageSize = event.pageSize;
    this.pageIndex = event.pageIndex;
    this.load();
  }

  generateAll(): void {
    this.generating.set(true);
    this.logSummaryService.generateAll().subscribe({
      next: (result) => {
        this.generating.set(false);
        const parts = [
          result.ticketSummaries && `${result.ticketSummaries} ticket`,
          result.orphanSummaries && `${result.orphanSummaries} orphan`,
          result.serviceSummaries && `${result.serviceSummaries} service`,
          result.uncategorizedSummaries && `${result.uncategorizedSummaries} uncategorized`,
        ].filter(Boolean);
        const msg = parts.length > 0 ? `Created ${parts.join(' + ')} summaries` : 'No new summaries to create';
        this.toast.info(msg);
        this.load();
      },
      error: () => {
        this.generating.set(false);
        this.toast.error('Failed to generate summaries');
      },
    });
  }

  typeLabel(summaryType: LogSummaryType): string {
    return TYPE_META[summaryType]?.label ?? 'Unknown';
  }

  typeColor(summaryType: LogSummaryType): string {
    return TYPE_META[summaryType]?.color ?? 'var(--text-tertiary)';
  }

  attentionClass(level: AttentionLevel): string {
    if (level === 'HIGH') return 'attention-high';
    if (level === 'MEDIUM') return 'attention-medium';
    return '';
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: true, hour: 'numeric', minute: '2-digit' });
  }
}
