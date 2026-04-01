import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DatePipe } from '@angular/common';
import {
  IngestionService,
  IngestionRun,
  IngestionRunDetail,
} from '../../core/services/ingestion.service';
import { ClientService, Client } from '../../core/services/client.service';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    DatePipe,
  ],
  template: `
    <div class="page-header">
      <h1>Ingestion Jobs</h1>
    </div>

    <!-- Live status banner -->
    @if (processingRun()) {
      <mat-card class="live-banner">
        <mat-card-content>
          <div class="live-header">
            <mat-progress-spinner diameter="20" mode="indeterminate"></mat-progress-spinner>
            <span class="live-title">Processing</span>
            <span class="live-meta">{{ processingRun()!.client.shortCode }} &middot; {{ processingRun()!.routeName ?? 'Unknown route' }}</span>
            <span class="live-elapsed">{{ getElapsed(processingRun()!) }}</span>
          </div>
          <div class="step-list">
            @for (step of processingRun()!.steps; track step.id) {
              <div class="step-item" [class]="'step-' + step.status">
                @if (step.status === 'success') {
                  <mat-icon class="step-icon done">check_circle</mat-icon>
                } @else if (step.status === 'processing') {
                  <mat-icon class="step-icon running">sync</mat-icon>
                } @else if (step.status === 'error') {
                  <mat-icon class="step-icon error">error</mat-icon>
                } @else if (step.status === 'skipped') {
                  <mat-icon class="step-icon skipped">skip_next</mat-icon>
                } @else {
                  <mat-icon class="step-icon pending">radio_button_unchecked</mat-icon>
                }
                <span class="step-name">{{ step.stepName }}</span>
                @if (step.status === 'processing') {
                  <mat-progress-spinner diameter="14" mode="indeterminate" class="step-spinner"></mat-progress-spinner>
                }
              </div>
            }
          </div>
        </mat-card-content>
      </mat-card>
    }

    <!-- Filters -->
    <div class="filters">
      <mat-form-field appearance="outline" class="filter-field">
        <mat-label>Status</mat-label>
        <mat-select [(ngModel)]="filterStatus" (selectionChange)="page = 0; loadRuns()">
          <mat-option value="">All</mat-option>
          <mat-option value="processing">Processing</mat-option>
          <mat-option value="success">Success</mat-option>
          <mat-option value="error">Error</mat-option>
          <mat-option value="no_route">No Route</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field appearance="outline" class="filter-field">
        <mat-label>Client</mat-label>
        <mat-select [(ngModel)]="filterClientId" (selectionChange)="page = 0; loadRuns()">
          <mat-option value="">All Clients</mat-option>
          @for (c of clients(); track c.id) {
            <mat-option [value]="c.id">{{ c.shortCode }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <span class="total-count">{{ total() }} runs total</span>
    </div>

    <!-- Runs table -->
    @if (runs().length === 0) {
      <mat-card class="empty-card">
        <p class="empty">No ingestion runs found.</p>
      </mat-card>
    } @else {
      <table mat-table [dataSource]="runs()" class="full-width runs-table" multiTemplateDataRows>
        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let r">
            <span class="badge" [class]="'badge-status-' + r.status">{{ r.status }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="source">
          <th mat-header-cell *matHeaderCellDef>Source</th>
          <td mat-cell *matCellDef="let r">
            <span class="badge badge-source">{{ r.source }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="client">
          <th mat-header-cell *matHeaderCellDef>Client</th>
          <td mat-cell *matCellDef="let r">{{ r.client.shortCode }}</td>
        </ng-container>

        <ng-container matColumnDef="route">
          <th mat-header-cell *matHeaderCellDef>Route</th>
          <td mat-cell *matCellDef="let r">{{ r.routeName ?? '—' }}</td>
        </ng-container>

        <ng-container matColumnDef="ticket">
          <th mat-header-cell *matHeaderCellDef>Ticket</th>
          <td mat-cell *matCellDef="let r">
            @if (r.ticketId) {
              <a [routerLink]="['/tickets', r.ticketId]" class="ticket-link">View</a>
            } @else {
              <span class="muted">—</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="startedAt">
          <th mat-header-cell *matHeaderCellDef>Started</th>
          <td mat-cell *matCellDef="let r">{{ r.startedAt | date:'short' }}</td>
        </ng-container>

        <ng-container matColumnDef="duration">
          <th mat-header-cell *matHeaderCellDef>Duration</th>
          <td mat-cell *matCellDef="let r">{{ getDuration(r) }}</td>
        </ng-container>

        <ng-container matColumnDef="steps">
          <th mat-header-cell *matHeaderCellDef>Steps</th>
          <td mat-cell *matCellDef="let r">{{ r.steps?.length ?? 0 }}</td>
        </ng-container>

        <ng-container matColumnDef="expand">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let r">
            <button mat-icon-button (click)="toggleExpand(r); $event.stopPropagation()"
              [attr.aria-label]="expandedRunId === r.id ? 'Collapse run details' : 'Expand run details'"
              [attr.aria-expanded]="expandedRunId === r.id">
              <mat-icon>{{ expandedRunId === r.id ? 'expand_less' : 'expand_more' }}</mat-icon>
            </button>
          </td>
        </ng-container>

        <!-- Expanded detail row -->
        <ng-container matColumnDef="expandedDetail">
          <td mat-cell *matCellDef="let r" [attr.colspan]="columns.length">
            @if (expandedRunId === r.id && expandedRun()) {
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
            }
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns;"
            class="run-row"
            [class.expanded-row]="expandedRunId === row.id"
            (click)="toggleExpand(row)"></tr>
        <tr mat-row *matRowDef="let row; columns: ['expandedDetail']"
            class="detail-row"
            [class.detail-row-visible]="expandedRunId === row.id"></tr>
      </table>

      <!-- Pagination -->
      @if (total() > pageSize) {
        <div class="pagination">
          <button mat-button [disabled]="page === 0" (click)="page = page - 1; loadRuns()">Previous</button>
          <span>Page {{ page + 1 }} of {{ totalPages() }}</span>
          <button mat-button [disabled]="page >= totalPages() - 1" (click)="page = page + 1; loadRuns()">Next</button>
        </div>
      }
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }

    .live-banner { margin-bottom: 16px; background: #e3f2fd; border-left: 4px solid #1565c0; }
    .live-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .live-title { font-weight: 600; color: #1565c0; }
    .live-meta { color: #555; font-size: 13px; }
    .live-elapsed { color: #777; font-size: 13px; margin-left: auto; }
    .step-list { display: flex; flex-direction: column; gap: 4px; }
    .step-item { display: flex; align-items: center; gap: 6px; font-size: 13px; }
    .step-icon { font-size: 18px; width: 18px; height: 18px; }
    .step-icon.done { color: #2e7d32; }
    .step-icon.running { color: #1565c0; animation: spin 1s linear infinite; }
    .step-icon.error { color: #c62828; }
    .step-icon.skipped { color: #e65100; }
    .step-icon.pending { color: #999; }
    .step-spinner { margin-left: 4px; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    .filters { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
    .filter-field { min-width: 160px; }
    .total-count { color: #666; font-size: 13px; }

    .runs-table { width: 100%; }
    .run-row { cursor: pointer; }
    .run-row:hover { background: #f5f5f5; }
    .expanded-row { background: #fafafa; }
    .detail-row { height: 0; overflow: hidden; }
    .detail-row td { padding: 0 !important; border-bottom: none; }
    .detail-row-visible { height: auto; overflow: visible; }
    .detail-row-visible td { padding: 8px 16px !important; border-bottom: 1px solid #e0e0e0; }

    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .badge.small { font-size: 10px; padding: 1px 6px; }
    .badge-status-success { background: #e8f5e9; color: #2e7d32; }
    .badge-status-error { background: #ffebee; color: #c62828; }
    .badge-status-no_route { background: #f5f5f5; color: #777; }
    .badge-status-processing { background: #e3f2fd; color: #1565c0; }
    .badge-status-pending { background: #f5f5f5; color: #777; }
    .badge-status-skipped { background: #fff3e0; color: #e65100; }
    .badge-source { background: #f3e5f5; color: #7b1fa2; }
    .badge-step-type { background: #e8eaf6; color: #3f51b5; }

    .ticket-link { color: #1565c0; text-decoration: none; font-weight: 500; }
    .ticket-link:hover { text-decoration: underline; }
    .muted { color: #999; }

    .run-error { padding: 8px 12px; background: #ffebee; color: #c62828; border-radius: 4px; margin-bottom: 8px; font-size: 13px; }

    .expanded-detail { padding: 8px 0; }
    .detail-step { padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
    .detail-step:last-child { border-bottom: none; }
    .detail-step-header { display: flex; align-items: center; gap: 8px; }
    .detail-step-order { font-weight: 600; color: #999; min-width: 20px; }
    .detail-step-name { font-weight: 500; }
    .detail-step-duration { font-size: 12px; color: #777; }
    .detail-step-error { margin-top: 4px; padding: 6px 8px; background: #ffebee; color: #c62828; border-radius: 4px; font-size: 13px; }
    .detail-step-output { margin-top: 4px; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: #1565c0; animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.3); } }

    .step-highlight { animation: highlight-fade 1.5s ease-out; }
    @keyframes highlight-fade { from { background: #c8e6c9; } to { background: transparent; } }

    .detail-step-output summary { cursor: pointer; color: #1565c0; font-size: 12px; }
    .detail-pre { background: #263238; color: #eeffff; padding: 8px 12px; border-radius: 4px; font-size: 12px; overflow-x: auto; max-height: 300px; white-space: pre-wrap; word-break: break-word; }

    .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 16px 0; }
    .empty { color: #999; text-align: center; padding: 24px 16px; margin: 0; }
    .empty-card { margin-bottom: 16px; }
    .full-width { width: 100%; }
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

  columns = ['status', 'source', 'client', 'route', 'ticket', 'startedAt', 'duration', 'steps', 'expand'];

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
