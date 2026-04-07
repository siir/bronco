import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Clipboard, ClipboardModule } from '@angular/cdk/clipboard';
import { DatePipe, DecimalPipe, SlicePipe } from '@angular/common';
import {
  BroncoButtonComponent,
  CardComponent,
  DataTableComponent,
  DataTableColumnComponent,
  FormFieldComponent,
  TextInputComponent,
  SelectComponent,
  PaginatorComponent,
  type PaginatorPageEvent,
} from '../../shared/components/index.js';
import {
  ScheduledProbeService,
  ScheduledProbe,
  ProbeRun,
  ProbeRunStep,
} from '../../core/services/scheduled-probe.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    ClipboardModule,
    DatePipe,
    DecimalPipe,
    SlicePipe,
    BroncoButtonComponent,
    CardComponent,
    DataTableComponent,
    DataTableColumnComponent,
    FormFieldComponent,
    TextInputComponent,
    SelectComponent,
    PaginatorComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <div class="header-left">
          <a routerLink="/scheduled-probes" class="back-link">
            <app-bronco-button variant="ghost" size="sm">&larr; Back to Probes</app-bronco-button>
          </a>
          @if (probe()) {
            <h1 class="page-title">
              {{ probe()!.name }}
              <span class="badge" [class]="probe()!.isActive ? 'badge-active' : 'badge-inactive'">
                {{ probe()!.isActive ? 'Active' : 'Inactive' }}
              </span>
            </h1>
            @if (probe()!.description) {
              <p class="probe-desc">{{ probe()!.description }}</p>
            }
          }
        </div>
        <div class="header-actions">
          <app-bronco-button variant="destructive" size="sm" (click)="purgeHistory()" [disabled]="purging">
            Purge History
          </app-bronco-button>
        </div>
      </div>

      <!-- Retention settings -->
      @if (probe()) {
        <app-card padding="md" class="retention-card">
          <div class="retention-row">
            <span class="retention-label">Retention</span>
            <app-form-field label="Days">
              <app-text-input
                type="number"
                [value]="retentionDays + ''"
                (valueChange)="retentionDays = parseIntSafe($event)" />
            </app-form-field>
            <app-form-field label="Max Runs">
              <app-text-input
                type="number"
                [value]="retentionMaxRuns + ''"
                (valueChange)="retentionMaxRuns = parseIntSafe($event)" />
            </app-form-field>
            <app-bronco-button variant="primary" size="sm" (click)="saveRetention()" [disabled]="!canSaveRetention">
              Save
            </app-bronco-button>
          </div>
        </app-card>
      }

      <!-- Live status banner -->
      @if (currentRun()) {
        <app-card padding="md" class="live-banner">
          <div class="live-header">
            <span class="spinner"></span>
            <span class="live-title">Running</span>
            <span class="live-elapsed">{{ getElapsed(currentRun()!) }}</span>
          </div>
          <div class="step-list">
            @for (step of currentRun()!.steps ?? []; track step.id) {
              <div class="step-item">
                @if (step.status === 'success') {
                  <span class="step-icon step-success" aria-hidden="true">&#10003;</span>
                } @else if (step.status === 'running') {
                  <span class="step-icon step-running" aria-hidden="true">
                    <span class="spinner spinner-sm"></span>
                  </span>
                } @else if (step.status === 'error') {
                  <span class="step-icon step-error" aria-hidden="true">&#10005;</span>
                } @else if (step.status === 'skipped') {
                  <span class="step-icon step-skipped" aria-hidden="true">&#8631;</span>
                } @else {
                  <span class="step-icon step-pending" aria-hidden="true">&#9675;</span>
                }
                <span class="step-name">{{ step.stepName }}</span>
              </div>
            }
          </div>
        </app-card>
      }

      <!-- Filters -->
      <div class="filters">
        <div class="filter-field">
          <app-form-field label="Status">
            <app-select
              [value]="filterStatus"
              [options]="statusOptions"
              (valueChange)="onStatusFilter($event)" />
          </app-form-field>
        </div>
        <span class="total-count">{{ total() }} runs total</span>
      </div>

      <!-- History table -->
      @if (runs().length === 0) {
        <app-card padding="md">
          <p class="empty-state">No probe runs found.</p>
        </app-card>
      } @else {
        <app-data-table
          [data]="runs()"
          [trackBy]="trackByRunId"
          (rowClick)="toggleExpand($event)"
          emptyMessage="No probe runs found">

          <app-data-column key="status" header="Status" width="100px" [sortable]="false">
            <ng-template #cell let-r>
              <span class="badge" [class]="'badge-status-' + r.status">{{ r.status }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="startedAt" header="Started" width="160px" [sortable]="false">
            <ng-template #cell let-r>{{ r.startedAt | date:'short' }}</ng-template>
          </app-data-column>

          <app-data-column key="duration" header="Duration" width="100px" [sortable]="false">
            <ng-template #cell let-r>{{ formatDuration(r.durationMs) }}</ng-template>
          </app-data-column>

          <app-data-column key="triggeredBy" header="Triggered" width="120px" [sortable]="false">
            <ng-template #cell let-r>
              <span class="badge" [class]="'badge-trigger-' + r.triggeredBy">{{ r.triggeredBy }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="result" header="Result" [sortable]="false">
            <ng-template #cell let-r>
              @if (r.error) {
                <span class="error-text" [attr.title]="r.error">{{ r.error | slice:0:80 }}</span>
              } @else if (r.result) {
                <span [attr.title]="r.result">{{ r.result | slice:0:80 }}</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="steps" header="Steps" width="80px" [sortable]="false">
            <ng-template #cell let-r>{{ r._count?.steps ?? 0 }}</ng-template>
          </app-data-column>

          <app-data-column key="expand" header="" width="60px" [sortable]="false">
            <ng-template #cell let-r>
              <div (click)="$event.stopPropagation()">
                <app-bronco-button
                  variant="icon"
                  size="sm"
                  (click)="toggleExpand(r)"
                  [attr.aria-label]="expandedRunId === r.id ? 'Collapse run details' : 'Expand run details'"
                  [attr.aria-expanded]="expandedRunId === r.id">
                  {{ expandedRunId === r.id ? '\u25B2' : '\u25BC' }}
                </app-bronco-button>
              </div>
            </ng-template>
          </app-data-column>
        </app-data-table>

        <!-- Pagination -->
        @if (total() > pageSize) {
          <app-paginator
            [length]="total()"
            [pageSize]="pageSize"
            [pageIndex]="page"
            [pageSizeOptions]="[20, 50, 100]"
            (page)="onPageChange($event)" />
        }

        <!-- Expanded run detail (rendered below table since data-table doesn't support expandable rows) -->
        @if (expandedRunId && expandedRun()) {
          <app-card padding="md" class="expanded-detail-panel">
            <div class="expanded-detail-header">
              <h3 class="expanded-detail-title">Run Detail</h3>
              <app-bronco-button variant="ghost" size="sm" (click)="closeExpand()">Close</app-bronco-button>
            </div>
            <div class="expanded-detail">
              @for (step of expandedRun()!.steps ?? []; track step.id) {
                <div class="detail-step" [class]="'detail-step-' + step.status">
                  <div class="detail-step-header">
                    <span class="detail-step-order">{{ step.stepOrder }}.</span>
                    <span class="detail-step-name">{{ step.stepName }}</span>
                    <span class="badge small" [class]="'badge-status-' + step.status">{{ step.status }}</span>
                    @if (step.startedAt && step.completedAt) {
                      <span class="detail-step-duration">{{ formatStepDuration(step) }}</span>
                    }
                  </div>
                  @if (step.error) {
                    <div class="detail-step-error">{{ step.error }}</div>
                  }
                  @if (step.detail) {
                    @if (isIntegrationStep(step)) {
                      <div class="step-output-section">
                        <div class="step-meta-row">
                          <span class="meta-label">MCP Server URL</span>
                          <code class="meta-value">{{ step.detail }}</code>
                        </div>
                      </div>
                    } @else if (isToolResultStep(step)) {
                      <div class="step-output-section">
                        <div class="step-meta-row">
                          <span class="meta-label">Tool (current config)</span>
                          <span class="badge badge-tool">{{ probe()?.toolName }}</span>
                        </div>
                        @if (getSystemParam()) {
                          <div class="step-meta-row">
                            <span class="meta-label">System (current config)</span>
                            <span class="badge badge-system">{{ getSystemParam() }}</span>
                          </div>
                        }
                        <div class="step-result-block">
                          <div class="result-toolbar">
                            <span class="result-label">Result</span>
                            <app-bronco-button
                              variant="icon"
                              size="sm"
                              [attr.title]="'Copy to clipboard'"
                              aria-label="Copy result to clipboard"
                              (click)="copyToClipboard(step.detail!); $event.stopPropagation()">
                              &#x2398;
                            </app-bronco-button>
                          </div>
                          @if (step.detail.length > 500 && !isStepExpanded(step.id)) {
                            <pre class="detail-pre">{{ step.detail.slice(0, 500) }}…</pre>
                            <app-bronco-button variant="ghost" size="sm" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                              Show full result ({{ step.detail.length | number }} chars)
                            </app-bronco-button>
                          } @else {
                            @if (getFormattedJson(step.id) !== null) {
                              <pre class="detail-pre detail-pre-json">{{ getFormattedJson(step.id) }}</pre>
                            } @else {
                              <pre class="detail-pre">{{ step.detail }}</pre>
                            }
                            @if (step.detail.length > 500) {
                              <app-bronco-button variant="ghost" size="sm" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                                Collapse
                              </app-bronco-button>
                            }
                          }
                        </div>
                      </div>
                    } @else if (isEvaluateStep(step)) {
                      <div class="step-output-section">
                        <div class="step-meta-row">
                          <span class="meta-label">Evaluation</span>
                          <span class="eval-result"
                            [class.eval-nonempty]="step.detail.includes('non-empty')"
                            [class.eval-empty]="step.status === 'skipped'">
                            {{ step.detail }}
                          </span>
                        </div>
                      </div>
                    } @else if (isIngestStep(step)) {
                      <div class="step-output-section">
                        <div class="step-meta-row">
                          <span class="meta-label">Status</span>
                          <span class="badge badge-status-success">{{ step.detail }}</span>
                        </div>
                        @if (probe()?.toolName) {
                          <div class="step-meta-row">
                            <span class="meta-label">Tool</span>
                            <span class="badge badge-tool">{{ probe()?.toolName }}</span>
                          </div>
                        }
                        @if (probe()?.category) {
                          <div class="step-meta-row">
                            <span class="meta-label">Category</span>
                            <span class="badge badge-category">{{ probe()?.category }}</span>
                          </div>
                        }
                        <div class="step-meta-row">
                          <span class="meta-label">Source</span>
                          <span class="badge badge-trigger-schedule">SCHEDULED</span>
                        </div>
                      </div>
                    } @else {
                      <details class="detail-step-output">
                        <summary>Output</summary>
                        <div class="result-toolbar">
                          <span></span>
                          <app-bronco-button
                            variant="icon"
                            size="sm"
                            [attr.title]="'Copy to clipboard'"
                            aria-label="Copy step output to clipboard"
                            (click)="copyToClipboard(step.detail!); $event.stopPropagation()">
                            &#x2398;
                          </app-bronco-button>
                        </div>
                        @if (step.detail.length > 500 && !isStepExpanded(step.id)) {
                          <pre class="detail-pre">{{ step.detail.slice(0, 500) }}…</pre>
                          <app-bronco-button variant="ghost" size="sm" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                            Show full output ({{ step.detail.length | number }} chars)
                          </app-bronco-button>
                        } @else {
                          <pre class="detail-pre">{{ step.detail }}</pre>
                          @if (step.detail.length > 500) {
                            <app-bronco-button variant="ghost" size="sm" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                              Collapse
                            </app-bronco-button>
                          }
                        }
                      </details>
                    }
                  }
                </div>
              }
            </div>
          </app-card>
        }
      }
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }

    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 16px;
      gap: 16px;
    }
    .header-left { display: flex; flex-direction: column; gap: 4px; }
    .back-link { display: inline-block; text-decoration: none; }
    .page-title {
      margin: 8px 0 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-primary);
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .probe-desc {
      color: var(--text-tertiary);
      margin: 4px 0 0;
      font-family: var(--font-primary);
      font-size: 13px;
    }
    .header-actions { display: flex; gap: 8px; align-items: center; }

    .retention-card { margin-bottom: 16px; }
    .retention-row {
      display: flex;
      align-items: flex-end;
      gap: 12px;
      flex-wrap: wrap;
    }
    .retention-label {
      font-weight: 500;
      font-size: 13px;
      color: var(--text-secondary);
      padding-bottom: 10px;
    }

    .live-banner {
      margin-bottom: 16px;
      border-left: 4px solid var(--accent);
    }
    .live-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .live-title {
      font-weight: 600;
      color: var(--accent);
      font-family: var(--font-primary);
      font-size: 14px;
    }
    .live-elapsed {
      color: var(--text-tertiary);
      font-size: 13px;
      font-family: var(--font-primary);
    }
    .step-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .step-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-family: var(--font-primary);
      color: var(--text-secondary);
    }
    .step-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      font-size: 14px;
      line-height: 1;
    }
    .step-success { color: var(--color-success); }
    .step-running { color: var(--accent); }
    .step-error { color: var(--color-error); }
    .step-skipped { color: var(--color-warning); }
    .step-pending { color: var(--text-tertiary); }
    .step-name { font-weight: 500; }

    /* CSS-only spinner */
    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid var(--border-light);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .spinner-sm {
      width: 12px;
      height: 12px;
      border-width: 2px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .filters {
      display: flex;
      gap: 16px;
      align-items: flex-end;
      margin-bottom: 16px;
    }
    .filter-field { min-width: 180px; }
    .total-count {
      color: var(--text-tertiary);
      font-size: 13px;
      font-family: var(--font-primary);
      padding-bottom: 10px;
    }

    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      white-space: nowrap;
      font-family: var(--font-primary);
    }
    .badge.small { font-size: 10px; padding: 1px 6px; }
    .badge-active {
      background: rgba(52, 199, 89, 0.1);
      color: var(--color-success);
    }
    .badge-inactive {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }
    .badge-status-success {
      background: rgba(52, 199, 89, 0.1);
      color: var(--color-success);
    }
    .badge-status-error {
      background: rgba(255, 59, 48, 0.1);
      color: var(--color-error);
    }
    .badge-status-skipped {
      background: rgba(255, 149, 0, 0.1);
      color: var(--color-warning);
    }
    .badge-status-running {
      background: var(--bg-active);
      color: var(--accent);
    }
    .badge-status-pending {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }
    .badge-trigger-schedule {
      background: rgba(0, 122, 255, 0.08);
      color: var(--color-info);
    }
    .badge-trigger-manual {
      background: var(--bg-muted);
      color: var(--text-secondary);
    }
    .badge-tool {
      background: var(--bg-active);
      color: var(--accent);
      font-family: ui-monospace, monospace;
    }
    .badge-system {
      background: rgba(255, 149, 0, 0.1);
      color: var(--color-warning);
      font-family: ui-monospace, monospace;
    }
    .badge-category {
      background: rgba(0, 122, 255, 0.08);
      color: var(--color-info);
    }
    .error-text { color: var(--color-error); }

    .empty-state {
      color: var(--text-tertiary);
      text-align: center;
      padding: 24px 16px;
      margin: 0;
      font-family: var(--font-primary);
      font-size: 14px;
    }

    .expanded-detail-panel { margin-top: 16px; }
    .expanded-detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-light);
    }
    .expanded-detail-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .expanded-detail { padding: 4px 0; }

    .detail-step {
      padding: 8px 0;
      border-bottom: 1px solid var(--border-light);
    }
    .detail-step:last-child { border-bottom: none; }
    .detail-step-header {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-primary);
    }
    .detail-step-order {
      font-weight: 600;
      color: var(--text-tertiary);
      min-width: 20px;
      font-size: 13px;
    }
    .detail-step-name {
      font-weight: 500;
      color: var(--text-primary);
      font-size: 13px;
    }
    .detail-step-duration {
      font-size: 12px;
      color: var(--text-tertiary);
    }
    .detail-step-error {
      margin-top: 6px;
      padding: 8px 10px;
      background: rgba(255, 59, 48, 0.08);
      color: var(--color-error);
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-family: var(--font-primary);
    }
    .detail-step-output { margin-top: 4px; }
    .detail-step-output summary {
      cursor: pointer;
      color: var(--accent);
      font-size: 12px;
      font-family: var(--font-primary);
    }
    .detail-pre {
      background: #1d1d1f;
      color: #f5f5f7;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      overflow-x: auto;
      max-height: 400px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    }
    .detail-pre-json { color: #a8e6a3; }

    .step-output-section {
      margin-top: 8px;
      padding: 8px 10px;
      background: var(--bg-muted);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-light);
    }
    .step-meta-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 0;
      font-size: 13px;
      font-family: var(--font-primary);
    }
    .meta-label {
      font-weight: 500;
      color: var(--text-tertiary);
      min-width: 100px;
      flex-shrink: 0;
    }
    .meta-value {
      font-size: 12px;
      color: var(--text-primary);
      background: var(--bg-card);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-family: ui-monospace, monospace;
    }

    .step-result-block { margin-top: 6px; }
    .result-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .result-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-tertiary);
      font-family: var(--font-primary);
    }

    .eval-result {
      font-size: 13px;
      font-weight: 500;
      font-family: var(--font-primary);
    }
    .eval-nonempty { color: var(--color-success); }
    .eval-empty { color: var(--color-warning); }
  `],
})
export class ProbeRunsComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private probeService = inject(ScheduledProbeService);
  private toast = inject(ToastService);
  private clipboard = inject(Clipboard);

  probe = signal<ScheduledProbe | null>(null);
  runs = signal<ProbeRun[]>([]);
  total = signal(0);
  currentRun = signal<ProbeRun | null>(null);
  expandedRunId: string | null = null;
  expandedRun = signal<ProbeRun | null>(null);
  expandedStepIds = new Set<string>();
  /** Precomputed formatted JSON per step id; null means content is not JSON. */
  private formattedJsonCache = new Map<string, string | null>();

  filterStatus = '';
  page = 0;
  pageSize = 20;
  purging = false;
  savingRetention = false;
  retentionDays = 30;
  retentionMaxRuns = 100;

  statusOptions = [
    { value: '', label: 'All' },
    { value: 'success', label: 'Success' },
    { value: 'error', label: 'Error' },
    { value: 'skipped', label: 'Skipped' },
    { value: 'running', label: 'Running' },
  ];

  trackByRunId = (item: ProbeRun) => item.id;

  private probeId = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.probeId = this.route.snapshot.paramMap.get('id') ?? '';
    this.probeService.getProbe(this.probeId).subscribe((p) => {
      this.probe.set(p);
      this.retentionDays = p.retentionDays;
      this.retentionMaxRuns = p.retentionMaxRuns;
    });
    this.loadRuns();
    this.pollCurrentRun();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  loadRuns(): void {
    const params: { limit: number; offset: number; status?: string } = {
      limit: this.pageSize,
      offset: this.page * this.pageSize,
    };
    if (this.filterStatus) params.status = this.filterStatus;
    this.probeService.getRuns(this.probeId, params).subscribe((res) => {
      this.runs.set(res.runs);
      this.total.set(res.total);
    });
  }

  totalPages(): number {
    return Math.ceil(this.total() / this.pageSize);
  }

  parseIntSafe(value: string): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  onStatusFilter(value: string): void {
    this.filterStatus = value;
    this.page = 0;
    this.loadRuns();
  }

  onPageChange(event: PaginatorPageEvent): void {
    this.page = event.pageIndex;
    this.pageSize = event.pageSize;
    this.loadRuns();
  }

  closeExpand(): void {
    this.expandedRunId = null;
    this.expandedRun.set(null);
    this.expandedStepIds.clear();
    this.formattedJsonCache.clear();
  }

  toggleExpand(run: ProbeRun): void {
    if (this.expandedRunId === run.id) {
      this.closeExpand();
      return;
    }
    this.expandedRunId = run.id;
    this.expandedRun.set(null);
    this.expandedStepIds.clear();
    this.formattedJsonCache.clear();
    this.probeService.getRun(this.probeId, run.id).subscribe((r) => {
      this.formattedJsonCache.clear();
      for (const step of r.steps ?? []) {
        if (step.detail) {
          const parsed = this.tryParseJson(step.detail.trim());
          this.formattedJsonCache.set(step.id, parsed !== null ? JSON.stringify(parsed, null, 2) : null);
        } else {
          this.formattedJsonCache.set(step.id, null);
        }
      }
      this.expandedRun.set(r);
    });
  }

  formatDuration(ms: number | null): string {
    if (ms == null) return '-';
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  }

  formatStepDuration(step: ProbeRunStep): string {
    if (!step.startedAt || !step.completedAt) return '';
    const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
    return this.formatDuration(ms);
  }

  getElapsed(run: ProbeRun): string {
    const elapsed = Date.now() - new Date(run.startedAt).getTime();
    return this.formatDuration(elapsed) + ' elapsed';
  }

  // -- Step type detection --

  isIntegrationStep(step: ProbeRunStep): boolean {
    return step.stepName === 'Load integration config';
  }

  isToolResultStep(step: ProbeRunStep): boolean {
    return step.stepName === 'Call MCP tool' || step.stepName === 'Execute built-in tool';
  }

  isEvaluateStep(step: ProbeRunStep): boolean {
    return step.stepName === 'Evaluate result';
  }

  isIngestStep(step: ProbeRunStep): boolean {
    return step.stepName === 'Enqueue to ingestion engine';
  }

  getSystemParam(): string | null {
    const params = this.probe()?.toolParams;
    if (!params) return null;
    const systemId = params['systemId'] ?? params['system_id'] ?? params['systemName'] ?? params['system_name'];
    return typeof systemId === 'string' ? systemId : null;
  }

  // -- Output formatting --

  /**
   * Returns the precomputed pretty-printed JSON for a step, or null if the
   * step detail is not valid JSON. Avoids re-parsing on every change detection cycle.
   */
  getFormattedJson(stepId: string): string | null {
    return this.formattedJsonCache.get(stepId) ?? null;
  }

  isJsonContent(text: string): boolean {
    const trimmed = text.trim();
    return (trimmed.startsWith('{') || trimmed.startsWith('[')) && this.tryParseJson(trimmed) !== null;
  }

  formatJson(text: string): string {
    const parsed = this.tryParseJson(text.trim());
    if (parsed === null) return text;
    return JSON.stringify(parsed, null, 2);
  }

  isStepExpanded(stepId: string): boolean {
    return this.expandedStepIds.has(stepId);
  }

  toggleStepExpand(stepId: string): void {
    if (this.expandedStepIds.has(stepId)) {
      this.expandedStepIds.delete(stepId);
    } else {
      this.expandedStepIds.add(stepId);
    }
  }

  copyToClipboard(text: string): void {
    const ok = this.clipboard.copy(text);
    if (ok) {
      this.toast.success('Copied to clipboard');
    } else {
      this.toast.error('Failed to copy to clipboard');
    }
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  purgeHistory(): void {
    if (!confirm('Delete all run history except the most recent 5?')) return;
    this.purging = true;
    this.probeService.purgeRuns(this.probeId).subscribe({
      next: (res) => {
        this.purging = false;
        this.toast.success(`Deleted ${res.deleted} runs`);
        this.loadRuns();
      },
      error: () => {
        this.purging = false;
        this.toast.error('Failed to purge history');
      },
    });
  }

  get canSaveRetention(): boolean {
    return (
      !this.savingRetention &&
      this.isValidRetention(this.retentionDays, 1, 365) &&
      this.isValidRetention(this.retentionMaxRuns, 5, 10000)
    );
  }

  private isValidRetention(val: unknown, min: number, max: number): val is number {
    return typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val) && val >= min && val <= max;
  }

  saveRetention(): void {
    if (!this.canSaveRetention) return;
    this.savingRetention = true;
    this.probeService.updateProbe(this.probeId, {
      retentionDays: this.retentionDays,
      retentionMaxRuns: this.retentionMaxRuns,
    }).subscribe({
      next: (p) => {
        this.savingRetention = false;
        this.probe.set(p);
        this.toast.success('Retention settings saved');
      },
      error: () => {
        this.savingRetention = false;
        this.toast.error('Failed to save retention settings');
      },
    });
  }

  private pollCurrentRun(): void {
    this.checkCurrentRun();
  }

  private checkCurrentRun(): void {
    this.probeService.getCurrentRun(this.probeId).subscribe({
      next: (run) => {
        const wasRunning = this.currentRun() !== null;
        this.currentRun.set(run);
        if (run) {
          // Active run — start polling if not already
          if (!this.pollTimer) {
            this.pollTimer = setInterval(() => this.checkCurrentRun(), 3000);
          }
        } else {
          // No active run — stop polling
          this.stopPolling();
          if (wasRunning) {
            // Run just completed — refresh the list
            this.loadRuns();
          }
        }
      },
      error: () => {
        // Transient error — keep polling so we recover on next tick
      },
    });
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
