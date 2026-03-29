import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import type { Subscription } from 'rxjs';
import { FailedJobsService, FailedJob } from '../../core/services/failed-jobs.service';
import { SystemStatusService, QueueStats } from '../../core/services/system-status.service';

const ALL_QUEUES = [
  'issue-resolve', 'log-summarize', 'email-ingestion', 'ticket-analysis',
  'ticket-created', 'ticket-ingest', 'devops-sync', 'mcp-discovery',
  'model-catalog-refresh', 'system-analysis', 'probe-execution',
] as const;

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatSelectModule,
    MatFormFieldModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatChipsModule,
  ],
  template: `
    <div class="page-header">
      <h1>Failed Jobs</h1>
      <div class="header-actions">
        @if (lastRefresh()) {
          <span class="last-refresh">Updated {{ lastRefresh() }}</span>
        }
        <button mat-raised-button (click)="refresh()" [disabled]="loading()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </div>
    </div>

    <!-- Summary bar -->
    <mat-card class="summary-bar">
      <mat-card-content>
        <div class="summary-content">
          <div class="summary-total">
            <mat-icon [class.has-failures]="totalFailed() > 0">error_outline</mat-icon>
            <span class="summary-count" [class.has-failures]="totalFailed() > 0">{{ totalFailed() }}</span>
            <span class="summary-label">total failed</span>
          </div>
          <div class="summary-queues">
            @for (entry of queueFailedEntries(); track entry[0]) {
              @if (entry[1] > 0) {
                <span class="queue-chip" (click)="selectedQueue.set(entry[0]); refresh()">
                  {{ entry[0] }}: {{ entry[1] }}
                </span>
              }
            }
          </div>
        </div>
      </mat-card-content>
    </mat-card>

    <!-- Filters -->
    <div class="filters">
      <mat-form-field appearance="outline" class="queue-filter">
        <mat-label>Filter by Queue</mat-label>
        <mat-select [value]="selectedQueue()" (selectionChange)="selectedQueue.set($event.value); refresh()">
          <mat-option value="">All Queues</mat-option>
          @for (q of allQueues; track q) {
            <mat-option [value]="q">{{ q }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      @if (selectedQueue()) {
        <button mat-stroked-button color="primary" (click)="retryAll()" [disabled]="acting()">
          <mat-icon>replay</mat-icon> Retry All in {{ selectedQueue() }}
        </button>
        <button mat-stroked-button color="warn" (click)="discardAll()" [disabled]="acting()">
          <mat-icon>delete_sweep</mat-icon> Discard All in {{ selectedQueue() }}
        </button>
      }
    </div>

    @if (loading() && jobs().length === 0) {
      <div class="loading-container">
        <mat-spinner diameter="40"></mat-spinner>
        <p>Loading failed jobs...</p>
      </div>
    }

    @if (!loading() && jobs().length === 0) {
      <mat-card class="empty-state">
        <mat-card-content>
          <mat-icon class="empty-icon">check_circle</mat-icon>
          <p>No failed jobs{{ selectedQueue() ? ' in ' + selectedQueue() : '' }}</p>
        </mat-card-content>
      </mat-card>
    }

    @if (jobs().length > 0) {
      <div class="job-list">
        @for (job of jobs(); track job.id + job.queue) {
          <mat-card class="job-card" [class.expanded]="expandedJob() === job.id + ':' + job.queue">
            <mat-card-content>
              <div class="job-header" (click)="toggleExpand(job)">
                <div class="job-main">
                  <span class="job-queue">{{ job.queue }}</span>
                  <span class="job-name">{{ job.name }}</span>
                  <span class="job-id">{{ job.id }}</span>
                </div>
                <div class="job-meta">
                  <span class="job-attempts">{{ job.attemptsMade }}/{{ job.maxAttempts || '?' }} attempts</span>
                  <span class="job-time">{{ formatTime(job.finishedOn || job.timestamp) }}</span>
                </div>
                <div class="job-actions" (click)="$event.stopPropagation()">
                  <button mat-icon-button matTooltip="Retry" (click)="retry(job)" [disabled]="acting()">
                    <mat-icon>replay</mat-icon>
                  </button>
                  <button mat-icon-button matTooltip="Discard" color="warn" (click)="discard(job)" [disabled]="acting()">
                    <mat-icon>delete</mat-icon>
                  </button>
                </div>
              </div>

              <div class="job-reason">{{ truncate(job.failedReason, 200) }}</div>

              @if (expandedJob() === job.id + ':' + job.queue) {
                <div class="job-detail">
                  <h4>Job Data</h4>
                  <pre class="json-block">{{ formatJson(job.data) }}</pre>

                  @if (job.failedReason) {
                    <h4>Error</h4>
                    <pre class="error-block">{{ job.failedReason }}</pre>
                  }

                  @if (job.stacktrace && job.stacktrace.length > 0) {
                    <h4>Stack Trace</h4>
                    <pre class="error-block">{{ job.stacktrace.join('\\n') }}</pre>
                  }
                </div>
              }
            </mat-card-content>
          </mat-card>
        }
      </div>

      @if (total() > jobs().length) {
        <div class="load-more">
          <button mat-stroked-button (click)="loadMore()" [disabled]="loading()">
            Load More ({{ jobs().length }} of {{ total() }})
          </button>
        </div>
      }
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .last-refresh { font-size: 12px; color: #888; }

    .summary-bar { margin-bottom: 16px; }
    .summary-content { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
    .summary-total { display: flex; align-items: center; gap: 8px; }
    .summary-total mat-icon { color: #4caf50; font-size: 28px; width: 28px; height: 28px; }
    .summary-total mat-icon.has-failures { color: #c62828; }
    .summary-count { font-size: 24px; font-weight: 600; font-family: monospace; }
    .summary-count.has-failures { color: #c62828; }
    .summary-label { color: #888; font-size: 14px; }
    .summary-queues { display: flex; gap: 8px; flex-wrap: wrap; }
    .queue-chip {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 12px;
      background: #ffebee;
      color: #c62828;
      font-family: monospace;
      cursor: pointer;
    }
    .queue-chip:hover { background: #ffcdd2; }

    .filters { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .queue-filter { min-width: 220px; }

    .loading-container { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 48px; }

    .empty-state mat-card-content { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px; color: #888; }
    .empty-icon { font-size: 48px; width: 48px; height: 48px; color: #4caf50; }

    .job-list { display: flex; flex-direction: column; gap: 8px; }

    .job-card { cursor: pointer; transition: box-shadow 0.15s; }
    .job-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }

    .job-header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .job-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
    .job-queue {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: #e3f2fd;
      color: #1565c0;
      font-family: monospace;
      white-space: nowrap;
    }
    .job-name { font-weight: 500; }
    .job-id { font-size: 12px; color: #888; font-family: monospace; }
    .job-meta { display: flex; align-items: center; gap: 12px; font-size: 12px; color: #888; white-space: nowrap; }
    .job-attempts { font-family: monospace; }
    .job-actions { display: flex; gap: 4px; }

    .job-reason {
      margin-top: 8px;
      font-size: 13px;
      color: #c62828;
      font-family: monospace;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .job-detail { margin-top: 16px; }
    .job-detail h4 { margin: 12px 0 4px; font-size: 13px; color: #555; }
    .json-block {
      background: #f5f5f5;
      padding: 12px;
      border-radius: 4px;
      font-size: 12px;
      overflow-x: auto;
      max-height: 300px;
      overflow-y: auto;
    }
    .error-block {
      background: #ffebee;
      padding: 12px;
      border-radius: 4px;
      font-size: 12px;
      color: #c62828;
      overflow-x: auto;
      max-height: 300px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .load-more { display: flex; justify-content: center; margin-top: 16px; }
  `],
})
export class FailedJobListComponent implements OnInit, OnDestroy {
  private failedJobsService = inject(FailedJobsService);
  private statusService = inject(SystemStatusService);
  private snackBar = inject(MatSnackBar);
  private route = inject(ActivatedRoute);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private sub: Subscription | undefined;
  private statusSub: Subscription | undefined;

  allQueues = ALL_QUEUES;
  loading = signal(false);
  acting = signal(false);
  jobs = signal<FailedJob[]>([]);
  total = signal(0);
  selectedQueue = signal('');
  expandedJob = signal<string | null>(null);
  lastRefresh = signal<string | null>(null);
  queueStats = signal<Record<string, QueueStats>>({});

  totalFailed = computed(() => {
    const stats = this.queueStats();
    return Object.values(stats).reduce((sum, s) => sum + (s.failed ?? 0), 0);
  });

  queueFailedEntries = computed(() => {
    const stats = this.queueStats();
    return Object.entries(stats)
      .filter(([, s]) => s.failed > 0)
      .map(([name, s]) => [name, s.failed] as [string, number])
      .sort((a, b) => b[1] - a[1]);
  });

  ngOnInit(): void {
    // Check for query param
    const qParam = this.route.snapshot.queryParamMap.get('queue');
    if (qParam && (ALL_QUEUES as readonly string[]).includes(qParam)) {
      this.selectedQueue.set(qParam);
    }
    this.refresh();
    this.refreshInterval = setInterval(() => this.refresh(), 10000);
  }

  ngOnDestroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.sub?.unsubscribe();
    this.statusSub?.unsubscribe();
  }

  refresh(): void {
    this.loading.set(true);
    const params: Record<string, string | number> = { limit: 50, offset: 0 };
    if (this.selectedQueue()) params['queue'] = this.selectedQueue();

    this.sub?.unsubscribe();
    this.sub = this.failedJobsService.list(params).subscribe({
      next: (res) => {
        this.jobs.set(res.jobs);
        this.total.set(res.total);
        this.loading.set(false);
        this.lastRefresh.set(new Date().toLocaleTimeString());
      },
      error: () => {
        this.loading.set(false);
        this.snackBar.open('Failed to load failed jobs', 'Dismiss', { duration: 4000 });
      },
    });

    // Also fetch queue stats for the summary; cancel previous in-flight request
    this.statusSub?.unsubscribe();
    this.statusSub = this.statusService.getStatus().subscribe({
      next: (res) => this.queueStats.set(res.queueStats ?? {}),
      error: () => {},
    });
  }

  loadMore(): void {
    this.loading.set(true);
    const params: Record<string, string | number> = { limit: 50, offset: this.jobs().length };
    if (this.selectedQueue()) params['queue'] = this.selectedQueue();

    this.failedJobsService.list(params).subscribe({
      next: (res) => {
        this.jobs.set([...this.jobs(), ...res.jobs]);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.snackBar.open('Failed to load more jobs', 'Dismiss', { duration: 4000 });
      },
    });
  }

  retry(job: FailedJob): void {
    this.acting.set(true);
    this.failedJobsService.retry(job.queue, job.id).subscribe({
      next: () => {
        this.acting.set(false);
        this.snackBar.open(`Job ${job.id} retried`, 'OK', { duration: 3000 });
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.snackBar.open(`Retry failed: ${err.error?.error ?? err.message}`, 'Dismiss', { duration: 4000 });
      },
    });
  }

  discard(job: FailedJob): void {
    if (!confirm(`Discard job ${job.id} from ${job.queue}? This cannot be undone.`)) return;
    this.acting.set(true);
    this.failedJobsService.discard(job.queue, job.id).subscribe({
      next: () => {
        this.acting.set(false);
        this.snackBar.open(`Job ${job.id} discarded`, 'OK', { duration: 3000 });
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.snackBar.open(`Discard failed: ${err.error?.error ?? err.message}`, 'Dismiss', { duration: 4000 });
      },
    });
  }

  retryAll(): void {
    const queue = this.selectedQueue();
    if (!queue) return;
    this.acting.set(true);
    this.failedJobsService.retryAll(queue).subscribe({
      next: (res) => {
        this.acting.set(false);
        const msg = res.failedCount > 0
          ? `Retried ${res.retriedCount} jobs in ${queue} (${res.failedCount} failed to retry)`
          : `Retried ${res.retriedCount} jobs in ${queue}`;
        this.snackBar.open(msg, 'OK', { duration: 3000 });
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.snackBar.open(`Retry all failed: ${err.error?.error ?? err.message}`, 'Dismiss', { duration: 4000 });
      },
    });
  }

  discardAll(): void {
    const queue = this.selectedQueue();
    if (!queue) return;
    if (!confirm(`Discard all failed jobs in ${queue}? This cannot be undone.`)) return;
    this.acting.set(true);
    this.failedJobsService.discardAll(queue).subscribe({
      next: (res) => {
        this.acting.set(false);
        this.snackBar.open(`Discarded ${res.removedCount} jobs in ${queue}`, 'OK', { duration: 3000 });
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.snackBar.open(`Discard all failed: ${err.error?.error ?? err.message}`, 'Dismiss', { duration: 4000 });
      },
    });
  }

  toggleExpand(job: FailedJob): void {
    const key = job.id + ':' + job.queue;
    this.expandedJob.set(this.expandedJob() === key ? null : key);
  }

  formatTime(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  formatJson(data: unknown): string {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  truncate(text: string, max: number): string {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '...' : text;
  }
}
