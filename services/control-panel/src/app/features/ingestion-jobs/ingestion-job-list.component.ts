import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import {
  IngestionService,
  IngestionRun,
  IngestionRunDetail,
} from '../../core/services/ingestion.service';
import { ClientService, Client } from '../../core/services/client.service';
import { BroncoButtonComponent, SelectComponent } from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
    BroncoButtonComponent,
    SelectComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1 class="page-title">Ingestion Jobs</h1>
      </div>

      <!-- Live status banner -->
      @if (processingRun()) {
        <div class="live-banner">
          <div class="live-header">
            <span class="live-pulse" aria-hidden="true"></span>
            <span class="live-title">Processing</span>
            <span class="live-meta">{{ processingRun()!.client.shortCode }} &middot; {{ processingRun()!.routeName ?? 'Unknown route' }}</span>
            <span class="live-elapsed">{{ getElapsed(processingRun()!) }}</span>
          </div>
          <div class="step-list">
            @for (step of processingRun()!.steps; track step.id) {
              <div class="step-item" [class]="'step-' + step.status">
                @if (step.status === 'success') {
                  <span class="step-icon done">&#10003;</span>
                } @else if (step.status === 'processing') {
                  <span class="step-icon running">&#9697;</span>
                } @else if (step.status === 'error') {
                  <span class="step-icon error">&#10005;</span>
                } @else if (step.status === 'skipped') {
                  <span class="step-icon skipped">&#8640;</span>
                } @else {
                  <span class="step-icon pending">&#9675;</span>
                }
                <span class="step-name">{{ step.stepName }}</span>
                @if (step.status === 'processing') {
                  <span class="step-spinner" aria-hidden="true"></span>
                }
              </div>
            }
          </div>
        </div>
      }

      <!-- Filters -->
      <div class="filters">
        <app-select
          [value]="filterStatus"
          [options]="statusOptions"
          [placeholder]="''"
          (valueChange)="filterStatus = $event; page = 0; loadRuns()">
        </app-select>
        <app-select
          [value]="filterClientId"
          [options]="clientOptions()"
          [placeholder]="''"
          (valueChange)="filterClientId = $event; page = 0; loadRuns()">
        </app-select>
        <span class="total-count">{{ total() }} runs total</span>
      </div>

      <!-- Runs table -->
      @if (runs().length === 0) {
        <div class="card empty-card">
          <p class="empty">No ingestion runs found.</p>
        </div>
      } @else {
        <div class="table-card">
          <table class="runs-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Source</th>
                <th>Client</th>
                <th>Route</th>
                <th>Ticket</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Steps</th>
                <th class="col-expand"></th>
              </tr>
            </thead>
            <tbody>
              @for (r of runs(); track r.id) {
                <tr class="run-row" [class.expanded-row]="expandedRunId === r.id" (click)="toggleExpand(r)">
                  <td><span class="badge" [class]="'badge-status-' + r.status">{{ r.status }}</span></td>
                  <td><span class="badge badge-source">{{ r.source }}</span></td>
                  <td>{{ r.client.shortCode }}</td>
                  <td>{{ r.routeName ?? '—' }}</td>
                  <td>
                    @if (r.ticketId) {
                      <a [routerLink]="['/tickets', r.ticketId]" class="ticket-link" (click)="$event.stopPropagation()">View</a>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                  <td>{{ r.startedAt | date:'short' }}</td>
                  <td>{{ getDuration(r) }}</td>
                  <td>{{ r.steps.length }}</td>
                  <td class="col-expand">
                    <app-bronco-button variant="icon" size="sm"
                      (click)="toggleExpand(r); $event.stopPropagation()"
                      [attr.aria-label]="expandedRunId === r.id ? 'Collapse run details' : 'Expand run details'"
                      [attr.aria-expanded]="expandedRunId === r.id">
                      {{ expandedRunId === r.id ? '▲' : '▼' }}
                    </app-bronco-button>
                  </td>
                </tr>
                @if (expandedRunId === r.id && expandedRun()) {
                  <tr class="detail-row-visible">
                    <td colspan="9">
                      <div class="expanded-detail">
                        @if (expandedRun()!.error) {
                          <div class="run-error">{{ expandedRun()!.error }}</div>
                        }
                        @for (step of expandedRun()!.steps; track step.id) {
                          <div class="detail-step" [class]="'detail-step-' + step.status"
                            [class.step-highlight]="recentlyChanged().has(step.id)">
                            <div class="detail-step-header">
                              <span class="detail-step-order">{{ step.stepOrder }}.</span>
                              <span class="detail-step-name">{{ step.stepName }}</span>
                              <span class="badge small" [class]="'badge-status-' + step.status">{{ step.status }}</span>
                              @if (step.status === 'processing') {
                                <span class="pulse-dot" aria-hidden="true"></span>
                              }
                              <span class="badge small badge-step-type">{{ step.stepType }}</span>
                              @if (step.durationMs != null) {
                                <span class="detail-step-duration">{{ formatDuration(step.durationMs) }}</span>
                              }
                            </div>
                            @if (step.error) {
                              <div class="detail-step-error">{{ step.error }}</div>
                            }
                            @if (step.output) {
                              <details class="detail-step-output">
                                <summary>Output</summary>
                                <pre class="detail-pre">{{ step.output }}</pre>
                              </details>
                            }
                          </div>
                        }
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        </div>

        <!-- Pagination -->
        @if (total() > pageSize) {
          <div class="pagination">
            <app-bronco-button variant="ghost" [disabled]="page === 0" (click)="page = page - 1; loadRuns()">Previous</app-bronco-button>
            <span class="page-info">Page {{ page + 1 }} of {{ totalPages() }}</span>
            <app-bronco-button variant="ghost" [disabled]="page >= totalPages() - 1" (click)="page = page + 1; loadRuns()">Next</app-bronco-button>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }

    .live-banner {
      margin-bottom: 16px;
      background: var(--color-info-subtle);
      border-left: 4px solid var(--accent);
      border-radius: var(--radius-md);
      padding: 16px;
    }
    .live-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .live-pulse {
      width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
      animation: pulse 1.5s ease-in-out infinite;
    }
    .live-title { font-family: var(--font-primary); font-weight: 600; color: var(--accent); }
    .live-meta { color: var(--text-tertiary); font-size: 13px; }
    .live-elapsed { color: var(--text-tertiary); font-size: 13px; margin-left: auto; }
    .step-list { display: flex; flex-direction: column; gap: 4px; }
    .step-item { display: flex; align-items: center; gap: 6px; font-family: var(--font-primary); font-size: 13px; color: var(--text-secondary); }
    .step-icon { font-size: 14px; width: 18px; text-align: center; }
    .step-icon.done { color: var(--color-success); }
    .step-icon.running { color: var(--accent); animation: spin 1s linear infinite; }
    .step-icon.error { color: var(--color-error); }
    .step-icon.skipped { color: var(--color-warning); }
    .step-icon.pending { color: var(--text-tertiary); }
    .step-spinner {
      width: 12px; height: 12px; border: 2px solid var(--border-light);
      border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    .step-name { font-family: var(--font-primary); }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.3); } }

    .filters { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
    .filters app-select { min-width: 160px; }
    .total-count { color: var(--text-tertiary); font-family: var(--font-primary); font-size: 13px; margin-left: auto; }

    .table-card {
      background: var(--bg-card); border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card); overflow: hidden; margin-bottom: 16px;
    }
    .runs-table { width: 100%; border-collapse: collapse; }
    .runs-table thead th {
      text-align: left; padding: 10px 16px; font-family: var(--font-primary);
      font-size: 12px; font-weight: 500; color: var(--text-tertiary);
      border-bottom: 1px solid var(--border-light); user-select: none;
    }
    .runs-table tbody td {
      padding: 12px 16px; font-family: var(--font-primary); font-size: 14px;
      color: var(--text-secondary); border-bottom: 1px solid var(--border-light);
    }
    .col-expand { width: 48px; text-align: center; }

    .run-row { cursor: pointer; transition: background 120ms ease; }
    .run-row:hover { background: var(--bg-hover); }
    .expanded-row { background: var(--bg-active); }

    .badge {
      font-family: var(--font-primary); font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: var(--radius-sm); white-space: nowrap;
    }
    .badge.small { font-size: 10px; padding: 1px 6px; }
    .badge-status-success { background: rgba(52, 199, 89, 0.12); color: var(--color-success); }
    .badge-status-error { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }
    .badge-status-no_route { background: var(--bg-muted); color: var(--text-tertiary); }
    .badge-status-processing { background: var(--color-info-subtle); color: var(--accent); }
    .badge-status-pending { background: var(--bg-muted); color: var(--text-tertiary); }
    .badge-status-skipped { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .badge-source { background: rgba(0, 113, 227, 0.08); color: var(--accent); }
    .badge-step-type { background: var(--bg-muted); color: var(--text-tertiary); }

    .ticket-link { color: var(--accent-link); text-decoration: none; font-family: var(--font-primary); font-weight: 500; }
    .ticket-link:hover { text-decoration: underline; }
    .muted { color: var(--text-tertiary); }

    .detail-row-visible td { padding: 8px 16px !important; border-bottom: 1px solid var(--border-light); background: var(--bg-page); }

    .run-error {
      padding: 8px 12px; background: rgba(255, 59, 48, 0.08); color: var(--color-error);
      border-radius: var(--radius-sm); margin-bottom: 8px; font-family: var(--font-primary); font-size: 13px;
    }
    .expanded-detail { padding: 8px 0; }
    .detail-step { padding: 6px 0; border-bottom: 1px solid var(--border-light); }
    .detail-step:last-child { border-bottom: none; }
    .detail-step-header { display: flex; align-items: center; gap: 8px; }
    .detail-step-order { font-family: var(--font-primary); font-weight: 600; color: var(--text-tertiary); min-width: 20px; }
    .detail-step-name { font-family: var(--font-primary); font-weight: 500; color: var(--text-primary); }
    .detail-step-duration { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); }
    .detail-step-error {
      margin-top: 4px; padding: 6px 8px; background: rgba(255, 59, 48, 0.08);
      color: var(--color-error); border-radius: var(--radius-sm); font-family: var(--font-primary); font-size: 13px;
    }
    .detail-step-output { margin-top: 4px; }
    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
      animation: pulse 1.5s ease-in-out infinite;
    }
    .step-highlight { animation: highlight-fade 1.5s ease-out; }
    @keyframes highlight-fade { from { background: rgba(52, 199, 89, 0.15); } to { background: transparent; } }
    .detail-step-output summary { cursor: pointer; color: var(--accent-link); font-family: var(--font-primary); font-size: 12px; }
    .detail-pre {
      background: #1d1d1f; color: #f5f5f7; padding: 8px 12px; border-radius: var(--radius-sm);
      font-size: 12px; overflow-x: auto; max-height: 300px; white-space: pre-wrap; word-break: break-word;
    }

    .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 16px 0; }
    .page-info { font-family: var(--font-primary); font-size: 13px; color: var(--text-tertiary); }
    .empty { color: var(--text-tertiary); text-align: center; padding: 24px 16px; margin: 0; font-family: var(--font-primary); }
    .empty-card { margin-bottom: 16px; }
    .card {
      background: var(--bg-card); border-radius: var(--radius-lg);
      padding: 16px; box-shadow: var(--shadow-card);
    }
  `],
})
export class IngestionJobListComponent implements OnInit, OnDestroy {
  private ingestionService = inject(IngestionService);
  private clientService = inject(ClientService);

  runs = signal<IngestionRun[]>([]);
  total = signal(0);
  clients = signal<Client[]>([]);
  expandedRunId: string | null = null;
  expandedRun = signal<IngestionRunDetail | null>(null);
  processingRun = signal<IngestionRun | null>(null);

  filterStatus = '';
  filterClientId = '';
  page = 0;
  pageSize = 20;

  statusOptions = [
    { value: '', label: 'All Statuses' },
    { value: 'processing', label: 'Processing' },
    { value: 'success', label: 'Success' },
    { value: 'error', label: 'Error' },
    { value: 'no_route', label: 'No Route' },
  ];

  clientOptions = computed(() => [
    { value: '', label: 'All Clients' },
    ...this.clients().map(c => ({ value: c.id, label: c.shortCode })),
  ]);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private detailPollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending recentlyChanged clear timeouts — cleared in stopDetailPolling/ngOnDestroy. */
  private recentlyChangedTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Track step statuses to detect transitions for highlight animation. */
  recentlyChanged = signal<Set<string>>(new Set());

  ngOnInit(): void {
    this.clientService.getClients().subscribe((c) => this.clients.set(c));
    this.loadRuns();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.stopDetailPolling();
    for (const t of this.recentlyChangedTimers) clearTimeout(t);
    this.recentlyChangedTimers.clear();
  }

  loadRuns(): void {
    const params: { limit: number; offset: number; status?: string; clientId?: string } = {
      limit: this.pageSize,
      offset: this.page * this.pageSize,
    };
    if (this.filterStatus) params.status = this.filterStatus;
    if (this.filterClientId) params.clientId = this.filterClientId;

    this.ingestionService.getRuns(params).subscribe({
      next: (res) => {
        this.runs.set(res.runs);
        this.total.set(res.total);

        // Check if any run is processing for live banner
        const processing = res.runs.find((r) => r.status === 'processing');
        this.processingRun.set(processing ?? null);

        // Start/stop polling based on processing state
        if (processing && !this.pollTimer) {
          this.pollTimer = setInterval(() => this.loadRuns(), 3000);
        } else if (!processing) {
          this.stopPolling();
        }
      },
      error: (err) => {
        console.error('Failed to load ingestion runs', err);
        this.stopPolling();
      },
    });
  }

  totalPages(): number {
    return Math.ceil(this.total() / this.pageSize);
  }

  toggleExpand(run: IngestionRun): void {
    if (this.expandedRunId === run.id) {
      this.expandedRunId = null;
      this.expandedRun.set(null);
      this.stopDetailPolling();
      return;
    }
    const runId = run.id;
    this.expandedRunId = runId;
    this.expandedRun.set(null);
    this.stopDetailPolling();
    this.ingestionService.getRun(runId).subscribe({
      next: (fullRun) => {
        // Guard against stale responses — user may have collapsed while the request was in flight
        if (this.expandedRunId !== runId) return;
        this.expandedRun.set(fullRun);
        if (fullRun.status === 'processing') {
          this.startDetailPolling(runId);
        }
      },
      error: (err) => console.error('Failed to load run detail', err),
    });
  }

  getDuration(run: IngestionRun): string {
    if (!run.completedAt) return run.status === 'processing' ? '...' : '—';
    const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    return this.formatDuration(ms);
  }

  formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  getElapsed(run: IngestionRun): string {
    const elapsed = Date.now() - new Date(run.startedAt).getTime();
    return this.formatDuration(elapsed) + ' elapsed';
  }

  private startDetailPolling(runId: string): void {
    // Clear any existing timer before scheduling a new one
    this.stopDetailPolling();

    const scheduleNext = (): void => {
      this.detailPollTimer = setTimeout(() => {
        this.ingestionService.getRun(runId).subscribe({
          next: (fullRun) => {
            // Detect step status transitions for highlight animation using O(1) Map lookup
            const prev = this.expandedRun();
            if (prev) {
              const prevMap = new Map(prev.steps.map((s) => [s.id, s]));
              const changed = new Set<string>();
              for (const step of fullRun.steps) {
                const prevStep = prevMap.get(step.id);
                if (prevStep && prevStep.status !== step.status && step.status !== 'processing') {
                  changed.add(step.id);
                }
              }
              if (changed.size > 0) {
                this.recentlyChanged.set(changed);
                const t = setTimeout(() => {
                  this.recentlyChanged.set(new Set());
                  this.recentlyChangedTimers.delete(t);
                }, 1500);
                this.recentlyChangedTimers.add(t);
              }
            }

            this.expandedRun.set(fullRun);

            // Stop polling when complete; otherwise schedule the next tick
            if (fullRun.status !== 'processing') {
              this.stopDetailPolling();
              // Refresh the list to update the row status
              this.loadRuns();
            } else {
              scheduleNext();
            }
          },
          error: (err) => {
            // Transient error — log but keep polling
            console.warn('Failed to poll run detail (will retry)', err);
            scheduleNext();
          },
        });
      }, 4000);
    };

    scheduleNext();
  }

  private stopDetailPolling(): void {
    if (this.detailPollTimer) {
      clearTimeout(this.detailPollTimer);
      this.detailPollTimer = null;
    }
    for (const t of this.recentlyChangedTimers) clearTimeout(t);
    this.recentlyChangedTimers.clear();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
