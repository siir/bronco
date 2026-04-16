import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import {
  IngestionService,
  IngestionRun,
} from '../../core/services/ingestion.service';
import { ClientService, Client } from '../../core/services/client.service';
import { DetailPanelService } from '../../core/services/detail-panel.service';
import {
  SelectComponent,
  IconComponent,
  DataTableComponent,
  DataTableColumnComponent,
  PaginatorComponent,
  type PaginatorPageEvent,
} from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
    SelectComponent,
    IconComponent,
    DataTableComponent,
    DataTableColumnComponent,
    PaginatorComponent,
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
                  <span class="step-icon done"><app-icon name="check" size="xs" /></span>
                } @else if (step.status === 'processing') {
                  <span class="step-icon running"><app-icon name="spinner" size="xs" /></span>
                } @else if (step.status === 'error') {
                  <span class="step-icon error"><app-icon name="close" size="xs" /></span>
                } @else if (step.status === 'skipped') {
                  <span class="step-icon skipped"><app-icon name="remove" size="xs" /></span>
                } @else {
                  <span class="step-icon pending"><app-icon name="pending" size="xs" /></span>
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
          (valueChange)="filterStatus = $event; page = 0; loadRuns()">
        </app-select>
        <app-select
          [value]="filterClientId"
          [options]="clientOptions()"
          (valueChange)="filterClientId = $event; page = 0; loadRuns()">
        </app-select>
        <span class="total-count">{{ total() }} runs total</span>
      </div>

      <app-data-table
        [data]="runs()"
        [trackBy]="trackById"
        (rowClick)="openDetail($event)"
        emptyMessage="No ingestion runs found.">

        <app-data-column key="status" header="Status" width="110px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            <span class="badge" [class]="'badge-status-' + row.status">{{ row.status }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="source" header="Source" width="100px" [sortable]="false" mobilePriority="hidden">
          <ng-template #cell let-row>
            <span class="badge badge-source">{{ row.source }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="client" header="Client" width="100px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            {{ row.client.shortCode }}
          </ng-template>
        </app-data-column>

        <app-data-column key="route" header="Route" [sortable]="false" mobilePriority="primary">
          <ng-template #cell let-row>
            <span class="route-name">{{ row.routeName ?? '—' }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="ticket" header="Ticket" width="80px" [sortable]="false" mobilePriority="hidden">
          <ng-template #cell let-row>
            @if (row.ticketId) {
              <a [routerLink]="['/tickets', row.ticketId]" class="ticket-link" (click)="$event.stopPropagation()">View</a>
            } @else {
              <span class="muted">—</span>
            }
          </ng-template>
        </app-data-column>

        <app-data-column key="started" header="Started" width="160px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            {{ row.startedAt | date:'short' }}
          </ng-template>
        </app-data-column>

        <app-data-column key="duration" header="Duration" width="100px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            {{ getDuration(row) }}
          </ng-template>
        </app-data-column>

        <app-data-column key="steps" header="Steps" width="80px" [sortable]="false" mobilePriority="hidden">
          <ng-template #cell let-row>
            {{ row.steps.length }}
          </ng-template>
        </app-data-column>
      </app-data-table>

      @if (total() > pageSize) {
        <app-paginator
          [length]="total()"
          [pageSize]="pageSize"
          [pageIndex]="page"
          [pageSizeOptions]="[20, 50, 100]"
          (page)="onPage($event)" />
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

    .badge {
      font-family: var(--font-primary); font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: var(--radius-sm); white-space: nowrap;
    }
    .badge-status-success { background: rgba(52, 199, 89, 0.12); color: var(--color-success); }
    .badge-status-error { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }
    .badge-status-no_route { background: var(--bg-muted); color: var(--text-tertiary); }
    .badge-status-processing { background: var(--color-info-subtle); color: var(--accent); }
    .badge-status-pending { background: var(--bg-muted); color: var(--text-tertiary); }
    .badge-status-skipped { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .badge-source { background: rgba(0, 113, 227, 0.08); color: var(--accent); }

    .route-name { color: var(--text-primary); font-weight: 500; }
    .ticket-link { color: var(--accent-link); text-decoration: none; font-family: var(--font-primary); font-weight: 500; }
    .ticket-link:hover { text-decoration: underline; }
    .muted { color: var(--text-tertiary); }
  `],
})
export class IngestionJobListComponent implements OnInit, OnDestroy {
  private ingestionService = inject(IngestionService);
  private clientService = inject(ClientService);
  private detailPanel = inject(DetailPanelService);

  runs = signal<IngestionRun[]>([]);
  total = signal(0);
  clients = signal<Client[]>([]);
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

  trackById = (item: IngestionRun) => item.id;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.clientService.getClients().subscribe((c) => this.clients.set(c));
    this.loadRuns();
  }

  ngOnDestroy(): void {
    this.stopPolling();
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

  onPage(event: PaginatorPageEvent): void {
    this.pageSize = event.pageSize;
    this.page = event.pageIndex;
    this.loadRuns();
  }

  openDetail(run: IngestionRun): void {
    this.detailPanel.open('job', run.id);
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

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
