import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { SystemAnalysisService, type SystemAnalysis, type SystemAnalysisStats } from '../../core/services/system-analysis.service';
import { RejectDialogComponent } from './reject-dialog.component';
import { BroncoButtonComponent, SelectComponent } from '../../shared/components/index.js';

const STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING: { label: 'Pending Review', color: 'var(--color-warning)' },
  ACKNOWLEDGED: { label: 'Acknowledged', color: 'var(--color-success)' },
  REJECTED: { label: 'Rejected', color: 'var(--color-error)' },
};

@Component({
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    MatPaginatorModule,
    MatSnackBarModule,
    MatDialogModule,
    BroncoButtonComponent,
    SelectComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1 class="page-title">System Analysis</h1>
        <div class="header-actions">
          <app-bronco-button variant="secondary" (click)="load(); loadStats()">
            Refresh
          </app-bronco-button>
        </div>
      </div>

      @if (loading()) {
        <div class="loading-state">Loading...</div>
      }

      <div class="stats-row">
        @if (stats()) {
          <div class="stat-chip pending">
            <span>{{ pendingCount() }} Pending</span>
          </div>
          <div class="stat-chip acknowledged">
            <span>{{ acknowledgedCount() }} Acknowledged</span>
          </div>
          <div class="stat-chip rejected">
            <span>{{ rejectedCount() }} Rejected</span>
          </div>
        }
      </div>

      <div class="filters">
        <app-select
          [value]="statusFilter"
          [options]="statusFilterOptions"
          [placeholder]="''"
          (valueChange)="statusFilter = $event; resetAndLoad()">
        </app-select>
      </div>

      <div class="analysis-list">
        @for (a of analyses(); track a.id) {
          <div class="analysis-card" [style.border-left-color]="statusColor(a.status)">
            <div class="analysis-header">
              <div class="analysis-meta">
                <div class="analysis-title">
                  <a [routerLink]="['/tickets', a.ticketId]" class="ticket-link">
                    Ticket {{ a.ticketId.slice(0, 8) }}...
                  </a>
                  <span class="status-badge" [style.background]="statusColor(a.status)">{{ statusLabel(a.status) }}</span>
                </div>
                <span class="time-info">
                  {{ formatDate(a.createdAt) }}
                  @if (a.aiModel) {
                    &middot; {{ a.aiProvider }}/{{ a.aiModel }}
                  }
                </span>
              </div>
            </div>

            <hr class="divider">

            <div class="analysis-section">
              <h3>Analysis</h3>
              <div class="analysis-text">{{ a.analysis }}</div>
            </div>

            <div class="analysis-section">
              <h3>Suggestions</h3>
              <div class="suggestions-text">{{ a.suggestions }}</div>
              <app-bronco-button variant="secondary" size="sm" class="copy-btn"
                title="Copy suggestions to clipboard for a new coding session"
                aria-label="Copy suggestions to clipboard for a new coding session"
                (click)="copySuggestions(a)">
                Copy for Session
              </app-bronco-button>
            </div>

            @if (a.status === 'REJECTED' && a.rejectionReason) {
              <div class="analysis-section rejection">
                <h3>Rejection Reason</h3>
                <div class="rejection-text">{{ a.rejectionReason }}</div>
              </div>
            }

            <div class="action-bar">
              @if (a.status === 'PENDING') {
                <app-bronco-button variant="primary" (click)="acknowledge(a)">
                  Acknowledge
                </app-bronco-button>
                <app-bronco-button variant="destructive" (click)="openRejectDialog(a)">
                  Reject
                </app-bronco-button>
              }
              @if (a.status !== 'PENDING') {
                <app-bronco-button variant="secondary" (click)="reopen(a)" title="Reset to pending for re-review">
                  Reopen
                </app-bronco-button>
              }
              <app-bronco-button variant="icon" size="sm" (click)="deleteAnalysis(a)" title="Delete permanently" aria-label="Delete permanently">
                ✕
              </app-bronco-button>
            </div>
          </div>
        } @empty {
          @if (!loading()) {
            <p class="empty">No system analyses yet. Analyses are automatically generated when tickets are closed.</p>
          }
        }
      </div>

      <mat-paginator
        [length]="total()"
        [pageSize]="pageSize"
        [pageIndex]="pageIndex"
        [pageSizeOptions]="[10, 25, 50]"
        (page)="onPage($event)"
        showFirstLastButtons>
      </mat-paginator>
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

    .stats-row { display: flex; gap: 16px; margin-bottom: 16px; }
    .stat-chip {
      display: flex; align-items: center; gap: 6px; padding: 8px 16px;
      border-radius: var(--radius-md); font-family: var(--font-primary);
      font-weight: 500; font-size: 14px;
    }
    .stat-chip.pending { background: rgba(255, 149, 0, 0.08); color: var(--color-warning); }
    .stat-chip.acknowledged { background: rgba(52, 199, 89, 0.08); color: var(--color-success); }
    .stat-chip.rejected { background: rgba(255, 59, 48, 0.08); color: var(--color-error); }

    .filters { margin-bottom: 16px; }
    .filters app-select { min-width: 180px; }

    .analysis-list { display: flex; flex-direction: column; gap: 16px; margin-bottom: 16px; }

    .analysis-card {
      background: var(--bg-card); border-radius: var(--radius-lg); padding: 16px;
      box-shadow: var(--shadow-card); border-left: 4px solid var(--color-warning);
    }
    .analysis-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .analysis-meta { flex: 1; }
    .analysis-title { display: flex; align-items: center; gap: 8px; }
    .ticket-link {
      color: var(--accent-link); text-decoration: none;
      font-family: var(--font-primary); font-weight: 500; font-size: 15px;
    }
    .ticket-link:hover { text-decoration: underline; }
    .status-badge {
      font-family: var(--font-primary); font-size: 11px; color: var(--text-on-accent);
      padding: 2px 8px; border-radius: var(--radius-pill); font-weight: 500;
    }
    .time-info { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); }

    .divider { border: none; border-top: 1px solid var(--border-light); margin: 12px 0; }

    .analysis-section { margin-top: 12px; }
    .analysis-section h3 {
      margin: 0 0 6px; font-family: var(--font-primary); font-size: 13px; font-weight: 600;
      color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px;
    }
    .analysis-text, .suggestions-text, .rejection-text {
      white-space: pre-wrap; line-height: 1.6; font-family: var(--font-primary);
      color: var(--text-secondary); font-size: 14px;
    }
    .suggestions-text {
      background: var(--bg-muted); padding: 12px; border-radius: var(--radius-md); margin-bottom: 8px;
    }
    .copy-btn { margin-top: 4px; }
    .rejection {
      background: rgba(255, 59, 48, 0.04); padding: 12px; border-radius: var(--radius-md);
      border: 1px solid rgba(255, 59, 48, 0.15);
    }
    .rejection-text { color: var(--color-error); }

    .action-bar {
      display: flex; gap: 8px; margin-top: 16px; padding-top: 12px;
      border-top: 1px solid var(--border-light);
    }
    .empty {
      text-align: center; color: var(--text-tertiary); padding: 48px 0;
      font-family: var(--font-primary);
    }
  `],
})
export class SystemAnalysisComponent implements OnInit {
  private analysisService = inject(SystemAnalysisService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  analyses = signal<SystemAnalysis[]>([]);
  stats = signal<SystemAnalysisStats | null>(null);
  total = signal(0);
  loading = signal(false);

  statusFilter = '';
  pageSize = 10;
  pageIndex = 0;

  statusFilterOptions = [
    { value: '', label: 'All' },
    { value: 'PENDING', label: 'Pending' },
    { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
    { value: 'REJECTED', label: 'Rejected' },
  ];

  pendingCount(): number { return this.stats()?.byStatus['PENDING'] ?? 0; }
  acknowledgedCount(): number { return this.stats()?.byStatus['ACKNOWLEDGED'] ?? 0; }
  rejectedCount(): number { return this.stats()?.byStatus['REJECTED'] ?? 0; }

  ngOnInit(): void {
    this.load();
    this.loadStats();
  }

  load(): void {
    this.loading.set(true);
    this.analysisService.getAnalyses({
      status: this.statusFilter || undefined,
      limit: this.pageSize,
      offset: this.pageIndex * this.pageSize,
    }).subscribe({
      next: (response) => {
        this.analyses.set(response.analyses);
        this.total.set(response.total);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.snackBar.open('Failed to load analyses', 'OK', { duration: 5000 });
      },
    });
  }

  loadStats(): void {
    this.analysisService.getStats().subscribe({
      next: (s) => this.stats.set(s),
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

  acknowledge(a: SystemAnalysis): void {
    this.analysisService.acknowledge(a.id).subscribe({
      next: () => {
        this.snackBar.open('Analysis acknowledged', 'OK', { duration: 3000 });
        this.load();
        this.loadStats();
      },
      error: (err) => {
        this.snackBar.open(err.error?.error ?? 'Failed to acknowledge', 'OK', { duration: 5000 });
      },
    });
  }

  openRejectDialog(a: SystemAnalysis): void {
    const ref = this.dialog.open(RejectDialogComponent, { width: '500px' });
    ref.afterClosed().subscribe((reason: string | undefined) => {
      if (reason) {
        this.analysisService.reject(a.id, reason).subscribe({
          next: () => {
            this.snackBar.open('Analysis rejected', 'OK', { duration: 3000 });
            this.load();
            this.loadStats();
          },
          error: (err) => {
            this.snackBar.open(err.error?.error ?? 'Failed to reject', 'OK', { duration: 5000 });
          },
        });
      }
    });
  }

  reopen(a: SystemAnalysis): void {
    this.analysisService.reopen(a.id).subscribe({
      next: () => {
        this.snackBar.open('Analysis reopened', 'OK', { duration: 3000 });
        this.load();
        this.loadStats();
      },
      error: (err) => {
        this.snackBar.open(err.error?.error ?? 'Failed to reopen', 'OK', { duration: 5000 });
      },
    });
  }

  deleteAnalysis(a: SystemAnalysis): void {
    if (!confirm('Delete this analysis permanently?')) return;
    this.analysisService.delete(a.id).subscribe({
      next: () => {
        this.snackBar.open('Analysis deleted', 'OK', { duration: 3000 });
        this.load();
        this.loadStats();
      },
      error: (err) => {
        this.snackBar.open(err.error?.error ?? 'Failed to delete', 'OK', { duration: 5000 });
      },
    });
  }

  async copySuggestions(a: SystemAnalysis): Promise<void> {
    const text = `## System Improvement Suggestions\n\nFrom ticket ${a.ticketId}:\n\n${a.suggestions}`;
    try {
      await navigator.clipboard.writeText(text);
      this.snackBar.open('Suggestions copied to clipboard', 'OK', { duration: 3000 });
    } catch {
      this.snackBar.open('Failed to copy to clipboard', 'OK', { duration: 3000 });
    }
  }

  statusLabel(status: string): string {
    return STATUS_META[status]?.label ?? status;
  }

  statusColor(status: string): string {
    return STATUS_META[status]?.color ?? 'var(--text-tertiary)';
  }

  formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: true, hour: 'numeric', minute: '2-digit' });
  }
}
