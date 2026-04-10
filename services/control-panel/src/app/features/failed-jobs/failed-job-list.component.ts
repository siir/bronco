import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import type { Subscription } from 'rxjs';
import { FailedJobsService, FailedJob } from '../../core/services/failed-jobs.service';
import { SystemStatusService, QueueStats } from '../../core/services/system-status.service';
import { BroncoButtonComponent, ToolbarComponent, SelectComponent, CardComponent } from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

const ALL_QUEUES = [
  'issue-resolve', 'log-summarize', 'email-ingestion', 'ticket-analysis',
  'ticket-created', 'ticket-ingest', 'devops-sync', 'mcp-discovery',
  'model-catalog-refresh', 'system-analysis', 'probe-execution',
] as const;

@Component({
  standalone: true,
  imports: [
    BroncoButtonComponent,
    ToolbarComponent,
    SelectComponent,
    CardComponent,
  ],
  template: `
    <div class="page-header">
      <h1>Failed Jobs</h1>
      <div class="header-actions">
        @if (lastRefresh()) {
          <span class="last-refresh">Updated {{ lastRefresh() }}</span>
        }
        <app-bronco-button variant="secondary" size="sm" (click)="refresh()" [disabled]="loading()">
          ↻ Refresh
        </app-bronco-button>
      </div>
    </div>

    <!-- Summary bar -->
    <div class="summary-bar">
      <div class="summary-total">
        <span class="summary-icon" [class.has-failures]="totalFailed() > 0">{{ totalFailed() > 0 ? '⚠' : '✓' }}</span>
        <span class="summary-count" [class.has-failures]="totalFailed() > 0">{{ totalFailed() }}</span>
        <span class="summary-label">total failed</span>
      </div>
      <div class="summary-queues">
        @for (entry of queueFailedEntries(); track entry[0]) {
          @if (entry[1] > 0) {
            <button type="button" class="queue-chip has-failures" (click)="selectedQueue.set(entry[0]); refresh()">
              {{ entry[0] }}: {{ entry[1] }}
            </button>
          }
        }
      </div>
    </div>

    <!-- Filters -->
    <app-toolbar>
      <app-select
        [value]="selectedQueue()"
        [options]="queueOptions"
        (valueChange)="onQueueFilter($event)" />
      @if (selectedQueue()) {
        <app-bronco-button variant="secondary" size="sm" (click)="retryAll()" [disabled]="acting()">
          Retry All in {{ selectedQueue() }}
        </app-bronco-button>
        <app-bronco-button variant="destructive" size="sm" (click)="discardAll()" [disabled]="acting()">
          Discard All in {{ selectedQueue() }}
        </app-bronco-button>
      }
    </app-toolbar>

    @if (loading() && jobs().length === 0) {
      <div class="loading-state">Loading failed jobs...</div>
    }

    @if (!loading() && jobs().length === 0) {
      <app-card>
        <div class="empty-state">
          <span class="empty-icon">✓</span>
          <p>No failed jobs{{ selectedQueue() ? ' in ' + selectedQueue() : '' }}</p>
        </div>
      </app-card>
    }

    @if (jobs().length > 0) {
      <div class="job-list">
        @for (job of jobs(); track job.id + job.queue) {
          <div class="job-card" [class.expanded]="expandedJob() === job.id + ':' + job.queue">
            <div class="job-header" (click)="toggleExpand(job)">
              <div class="job-main">
                <span class="job-queue-badge">{{ job.queue }}</span>
                <span class="job-name">{{ job.name }}</span>
                <span class="job-id">{{ job.id }}</span>
              </div>
              <div class="job-meta">
                <span class="job-attempts">{{ job.attemptsMade }}/{{ job.maxAttempts || '?' }} attempts</span>
                <span class="job-time">{{ formatTime(job.finishedOn || job.timestamp) }}</span>
              </div>
              <div class="job-actions" (click)="$event.stopPropagation()">
                <app-bronco-button variant="icon" aria-label="Retry" (click)="retry(job)" [disabled]="acting()">
                  ↻
                </app-bronco-button>
                <app-bronco-button variant="icon" aria-label="Discard" (click)="discard(job)" [disabled]="acting()">
                  ✕
                </app-bronco-button>
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
          </div>
        }
      </div>

      @if (total() > jobs().length) {
        <div class="load-more">
          <app-bronco-button variant="secondary" (click)="loadMore()" [disabled]="loading()">
            Load More ({{ jobs().length }} of {{ total() }})
          </app-bronco-button>
        </div>
      }
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; font-size: 21px; font-weight: 600; color: var(--text-primary); }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .last-refresh { font-size: 12px; color: var(--text-tertiary); }

    .summary-bar {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      padding: 16px 20px;
      box-shadow: var(--shadow-card);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .summary-total { display: flex; align-items: center; gap: 8px; }
    .summary-icon { font-size: 22px; color: var(--color-success); }
    .summary-icon.has-failures { color: var(--color-error); }
    .summary-count { font-size: 24px; font-weight: 600; font-family: ui-monospace, monospace; color: var(--text-primary); }
    .summary-count.has-failures { color: var(--color-error); }
    .summary-label { color: var(--text-tertiary); font-size: 14px; }
    .summary-queues { display: flex; gap: 8px; flex-wrap: wrap; }
    .queue-chip {
      font-size: 12px;
      font-weight: 500;
      padding: 3px 10px;
      border-radius: var(--radius-pill);
      cursor: pointer;
      transition: all 120ms ease;
      border: none;
      background: none;
    }
    .queue-chip.has-failures {
      background: rgba(255,59,48,0.08);
      color: var(--color-error);
      border: 1px solid rgba(255,59,48,0.2);
    }
    .queue-chip:hover { background: rgba(255,59,48,0.14); }

    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px;
      color: var(--text-tertiary);
      font-size: 14px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 48px;
      color: var(--text-tertiary);
    }
    .empty-icon { font-size: 40px; color: var(--color-success); }

    .job-list { display: flex; flex-direction: column; gap: 8px; }

    .job-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      margin-bottom: 8px;
      overflow: hidden;
    }

    .job-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      cursor: pointer;
      transition: background 120ms ease;
      flex-wrap: wrap;
    }
    .job-header:hover { background: var(--bg-hover); }

    .job-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }

    .job-queue-badge {
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      background: var(--bg-active);
      color: var(--accent);
      border-radius: var(--radius-sm);
      font-family: ui-monospace, monospace;
      white-space: nowrap;
    }
    .job-name { font-weight: 500; color: var(--text-primary); font-size: 14px; }
    .job-id { font-size: 12px; color: var(--text-tertiary); font-family: ui-monospace, monospace; }
    .job-meta { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--text-tertiary); white-space: nowrap; }
    .job-attempts { font-family: ui-monospace, monospace; }
    .job-actions { display: flex; gap: 4px; }

    .job-reason {
      padding: 0 16px 12px;
      font-size: 12px;
      color: var(--color-error);
      font-family: ui-monospace, monospace;
      line-height: 1.4;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .job-detail {
      padding: 12px 16px;
      border-top: 1px solid var(--border-light);
    }
    .job-detail h4 { margin: 12px 0 4px; font-size: 13px; color: var(--text-secondary); }

    .json-block, .error-block {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      padding: 12px;
      border-radius: var(--radius-md);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 300px;
      overflow-y: auto;
    }
    .json-block {
      background: var(--bg-muted);
      color: var(--text-secondary);
    }
    .error-block {
      background: rgba(255,59,48,0.05);
      color: var(--color-error);
    }

    .load-more { display: flex; justify-content: center; margin-top: 16px; }
  `],
})
export class FailedJobListComponent implements OnInit, OnDestroy {
  private failedJobsService = inject(FailedJobsService);
  private statusService = inject(SystemStatusService);
  private toast = inject(ToastService);
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

  queueOptions = [
    { value: '', label: 'All Queues' },
    ...ALL_QUEUES.map(q => ({ value: q, label: q })),
  ];

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

  onQueueFilter(value: string): void {
    this.selectedQueue.set(value);
    this.refresh();
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
        this.toast.error('Failed to load failed jobs');
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
        this.toast.error('Failed to load more jobs');
      },
    });
  }

  retry(job: FailedJob): void {
    this.acting.set(true);
    this.failedJobsService.retry(job.queue, job.id).subscribe({
      next: () => {
        this.acting.set(false);
        this.toast.success(`Job ${job.id} retried`);
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.toast.error(`Retry failed: ${err.error?.error ?? err.message}`);
      },
    });
  }

  discard(job: FailedJob): void {
    if (!confirm(`Discard job ${job.id} from ${job.queue}? This cannot be undone.`)) return;
    this.acting.set(true);
    this.failedJobsService.discard(job.queue, job.id).subscribe({
      next: () => {
        this.acting.set(false);
        this.toast.success(`Job ${job.id} discarded`);
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.toast.error(`Discard failed: ${err.error?.error ?? err.message}`);
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
        this.toast.info(msg);
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.toast.error(`Retry all failed: ${err.error?.error ?? err.message}`);
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
        this.toast.success(`Discarded ${res.removedCount} jobs in ${queue}`);
        this.refresh();
      },
      error: (err) => {
        this.acting.set(false);
        this.toast.error(`Discard all failed: ${err.error?.error ?? err.message}`);
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
