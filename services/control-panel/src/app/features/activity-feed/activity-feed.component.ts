import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatChipsModule } from '@angular/material/chips';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LogSummaryService, type LogSummary, type LogSummaryType, type AttentionLevel } from '../../core/services/log-summary.service';

const TYPE_META: Record<LogSummaryType, { icon: string; label: string; color: string }> = {
  TICKET: { icon: 'confirmation_number', label: 'Ticket', color: '#3f51b5' },
  ORPHAN: { icon: 'warning_amber', label: 'Orphaned Ticket', color: '#ff9800' },
  SERVICE: { icon: 'dns', label: 'Service Activity', color: '#9e9e9e' },
  UNCATEGORIZED: { icon: 'help_outline', label: 'Uncategorized', color: '#607d8b' },
};

@Component({
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    RouterLink,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatChipsModule,
    MatPaginatorModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page-header">
      <h1>Activity Feed</h1>
      <div class="header-actions">
        <button mat-raised-button (click)="generateAll()" [disabled]="generating()">
          <mat-icon>auto_awesome</mat-icon>
          {{ generating() ? 'Summarizing...' : 'Summarize All' }}
        </button>
        <button mat-raised-button (click)="load()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </div>
    </div>

    @if (generating()) {
      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
    }

    <div class="filters">
      <mat-form-field>
        <mat-label>Filter</mat-label>
        <mat-select [(ngModel)]="typeFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="all">All Summaries</mat-option>
          <mat-option value="ticket">Ticket Summaries</mat-option>
          <mat-option value="orphan">Orphan Summaries</mat-option>
          <mat-option value="service">Service Summaries</mat-option>
          <mat-option value="uncategorized">Uncategorized</mat-option>
        </mat-select>
      </mat-form-field>
    </div>

    <div class="feed">
      @for (s of summaries(); track s.id) {
        <mat-card [class]="'summary-card ' + attentionClass(s.attentionLevel)" [style.border-left-color]="typeColor(s.summaryType)">
          <mat-card-content>
            <div class="summary-header">
              <mat-icon class="type-icon">{{ typeIcon(s.summaryType) }}</mat-icon>
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
                <span class="log-count" [matTooltip]="s.logCount + ' log entries'">
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
          </mat-card-content>
        </mat-card>
      } @empty {
        @if (!generating()) {
          <p class="empty">No log summaries yet. Click "Summarize All" to generate summaries from existing logs.</p>
        }
      }
    </div>

    <mat-paginator
      [length]="total()"
      [pageSize]="pageSize"
      [pageIndex]="pageIndex"
      [pageSizeOptions]="[20, 50, 100]"
      (page)="onPage($event)"
      showFirstLastButtons>
    </mat-paginator>
  `,
  styles: [`
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }
    .filters {
      margin-bottom: 16px;
    }
    .feed {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 16px;
    }
    .summary-card {
      border-left: 4px solid #3f51b5;
      transition: background-color 0.2s;
    }
    .attention-high {
      background-color: rgba(244, 67, 54, 0.08);
      border-left-color: #f44336 !important;
    }
    .attention-medium {
      background-color: rgba(255, 152, 0, 0.08);
      border-left-color: #ff9800 !important;
    }
    .attention-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      margin-right: 8px;
    }
    .attention-badge.attention-high {
      background: rgba(244, 67, 54, 0.15);
      color: #d32f2f;
    }
    .attention-badge.attention-medium {
      background: rgba(255, 152, 0, 0.15);
      color: #e65100;
    }
    .summary-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .type-icon {
      color: #666;
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
    .summary-meta {
      display: flex;
      flex-direction: column;
      flex: 1;
    }
    .ticket-link {
      color: #3f51b5;
      text-decoration: none;
      font-weight: 500;
    }
    .ticket-link:hover {
      text-decoration: underline;
    }
    .type-label {
      font-weight: 500;
      color: #666;
    }
    .time-range {
      font-size: 12px;
      color: #999;
    }
    .summary-stats {
      text-align: right;
    }
    .log-count {
      font-size: 12px;
      color: #666;
      background: #f0f0f0;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .summary-text {
      margin: 8px 0;
      line-height: 1.5;
      color: #333;
    }
    .attention-high .summary-text {
      color: #c62828;
    }
    .attention-medium .summary-text {
      color: #bf360c;
    }
    .service-chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .service-chip {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: #e8eaf6;
      color: #3f51b5;
    }
    .empty {
      text-align: center;
      color: #999;
      padding: 48px 0;
    }
  `],
})
export class ActivityFeedComponent implements OnInit, OnDestroy {
  private logSummaryService = inject(LogSummaryService);
  private snackBar = inject(MatSnackBar);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  summaries = signal<LogSummary[]>([]);
  total = signal(0);
  generating = signal(false);

  typeFilter = 'all';
  pageSize = 20;
  pageIndex = 0;

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

  onPage(event: PageEvent): void {
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
        this.snackBar.open(msg, 'OK', { duration: 5000 });
        this.load();
      },
      error: () => {
        this.generating.set(false);
        this.snackBar.open('Failed to generate summaries', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  typeIcon(summaryType: LogSummaryType): string {
    return TYPE_META[summaryType]?.icon ?? 'help_outline';
  }

  typeLabel(summaryType: LogSummaryType): string {
    return TYPE_META[summaryType]?.label ?? 'Unknown';
  }

  typeColor(summaryType: LogSummaryType): string {
    return TYPE_META[summaryType]?.color ?? '#9e9e9e';
  }

  attentionClass(level: AttentionLevel): string {
    if (level === 'HIGH') return 'attention-high';
    if (level === 'MEDIUM') return 'attention-medium';
    return '';
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
}
