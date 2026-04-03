import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatChipsModule } from '@angular/material/chips';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { SystemAnalysisService, type SystemAnalysis, type SystemAnalysisStats } from '../../core/services/system-analysis.service';
import { RejectDialogComponent } from './reject-dialog.component';

const STATUS_META: Record<string, { icon: string; label: string; color: string }> = {
  PENDING: { icon: 'pending_actions', label: 'Pending Review', color: '#ff9800' },
  ACKNOWLEDGED: { icon: 'check_circle', label: 'Acknowledged', color: '#4caf50' },
  REJECTED: { icon: 'cancel', label: 'Rejected', color: '#f44336' },
};

@Component({
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatChipsModule,
    MatPaginatorModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatDialogModule,
    MatDividerModule,
  ],
  template: `
    <div class="page-header">
      <h1>System Analysis</h1>
      <div class="header-actions">
        <button mat-raised-button (click)="load(); loadStats()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </div>
    </div>

    @if (loading()) {
      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
    }

    <div class="stats-row">
      @if (stats()) {
        <div class="stat-chip pending">
          <mat-icon>pending_actions</mat-icon>
          <span>{{ pendingCount() }} Pending</span>
        </div>
        <div class="stat-chip acknowledged">
          <mat-icon>check_circle</mat-icon>
          <span>{{ acknowledgedCount() }} Acknowledged</span>
        </div>
        <div class="stat-chip rejected">
          <mat-icon>cancel</mat-icon>
          <span>{{ rejectedCount() }} Rejected</span>
        </div>
      }
    </div>

    <div class="filters">
      <mat-form-field>
        <mat-label>Status Filter</mat-label>
        <mat-select [(ngModel)]="statusFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All</mat-option>
          <mat-option value="PENDING">Pending</mat-option>
          <mat-option value="ACKNOWLEDGED">Acknowledged</mat-option>
          <mat-option value="REJECTED">Rejected</mat-option>
        </mat-select>
      </mat-form-field>
    </div>

    <div class="analysis-list">
      @for (a of analyses(); track a.id) {
        <mat-card class="analysis-card" [style.border-left-color]="statusColor(a.status)">
          <mat-card-content>
            <div class="analysis-header">
              <mat-icon class="status-icon" [style.color]="statusColor(a.status)">{{ statusIcon(a.status) }}</mat-icon>
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

            <mat-divider></mat-divider>

            <div class="analysis-section">
              <h3>Analysis</h3>
              <div class="analysis-text">{{ a.analysis }}</div>
            </div>

            <div class="analysis-section">
              <h3>Suggestions</h3>
              <div class="suggestions-text">{{ a.suggestions }}</div>
              <button mat-stroked-button class="copy-btn" (click)="copySuggestions(a)" matTooltip="Copy suggestions to clipboard for a new coding session">
                <mat-icon>content_copy</mat-icon> Copy for Session
              </button>
            </div>

            @if (a.status === 'REJECTED' && a.rejectionReason) {
              <div class="analysis-section rejection">
                <h3>Rejection Reason</h3>
                <div class="rejection-text">{{ a.rejectionReason }}</div>
              </div>
            }

            <div class="action-bar">
              @if (a.status === 'PENDING') {
                <button mat-raised-button color="primary" (click)="acknowledge(a)">
                  <mat-icon>check</mat-icon> Acknowledge
                </button>
                <button mat-raised-button color="warn" (click)="openRejectDialog(a)">
                  <mat-icon>close</mat-icon> Reject
                </button>
              }
              @if (a.status !== 'PENDING') {
                <button mat-stroked-button (click)="reopen(a)" matTooltip="Reset to pending for re-review">
                  <mat-icon>undo</mat-icon> Reopen
                </button>
              }
              <button mat-icon-button color="warn" (click)="deleteAnalysis(a)" matTooltip="Delete permanently">
                <mat-icon>delete</mat-icon>
              </button>
            </div>
          </mat-card-content>
        </mat-card>
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
    .stats-row {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
    }
    .stat-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 500;
      font-size: 14px;
    }
    .stat-chip.pending { background: #fff3e0; color: #e65100; }
    .stat-chip.acknowledged { background: #e8f5e9; color: #2e7d32; }
    .stat-chip.rejected { background: #ffebee; color: #c62828; }
    .stat-chip mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .filters {
      margin-bottom: 16px;
    }
    .analysis-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
      margin-bottom: 16px;
    }
    .analysis-card {
      border-left: 4px solid #ff9800;
    }
    .analysis-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .status-icon {
      font-size: 24px;
      width: 24px;
      height: 24px;
    }
    .analysis-meta {
      flex: 1;
    }
    .analysis-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ticket-link {
      color: #3f51b5;
      text-decoration: none;
      font-weight: 500;
      font-size: 15px;
    }
    .ticket-link:hover {
      text-decoration: underline;
    }
    .status-badge {
      font-size: 11px;
      color: white;
      padding: 2px 8px;
      border-radius: 12px;
      font-weight: 500;
    }
    .time-info {
      font-size: 12px;
      color: #999;
    }
    .analysis-section {
      margin-top: 12px;
    }
    .analysis-section h3 {
      margin: 0 0 6px;
      font-size: 13px;
      font-weight: 600;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .analysis-text, .suggestions-text, .rejection-text {
      white-space: pre-wrap;
      line-height: 1.6;
      color: #333;
      font-size: 14px;
    }
    .suggestions-text {
      background: #f5f5f5;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 8px;
    }
    .copy-btn {
      margin-top: 4px;
    }
    .rejection {
      background: #fff8f8;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #ffcdd2;
    }
    .rejection-text {
      color: #c62828;
    }
    .action-bar {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #e0e0e0;
    }
    .empty {
      text-align: center;
      color: #999;
      padding: 48px 0;
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

  statusIcon(status: string): string {
    return STATUS_META[status]?.icon ?? 'help_outline';
  }

  statusLabel(status: string): string {
    return STATUS_META[status]?.label ?? status;
  }

  statusColor(status: string): string {
    return STATUS_META[status]?.color ?? '#9e9e9e';
  }

  formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
}
