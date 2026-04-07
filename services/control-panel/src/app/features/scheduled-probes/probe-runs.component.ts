import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Clipboard, ClipboardModule } from '@angular/cdk/clipboard';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DatePipe, DecimalPipe, SlicePipe } from '@angular/common';
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
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    DatePipe,
    DecimalPipe,
    SlicePipe,
  ],
  template: `
    <div class="page-header">
      <div>
        <a routerLink="/scheduled-probes" class="back-link">
          <mat-icon>arrow_back</mat-icon> Back to Probes
        </a>
        @if (probe()) {
          <h1>
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
        <button mat-stroked-button color="warn" (click)="purgeHistory()" [disabled]="purging">
          <mat-icon>delete_sweep</mat-icon> Purge History
        </button>
      </div>
    </div>

    <!-- Retention settings -->
    @if (probe()) {
      <mat-card class="retention-card">
        <mat-card-content>
          <div class="retention-row">
            <span class="retention-label">Retention:</span>
            <mat-form-field appearance="outline" class="retention-field">
              <mat-label>Days</mat-label>
              <input matInput type="number" [(ngModel)]="retentionDays" min="1" max="365">
            </mat-form-field>
            <mat-form-field appearance="outline" class="retention-field">
              <mat-label>Max Runs</mat-label>
              <input matInput type="number" [(ngModel)]="retentionMaxRuns" min="5" max="10000">
            </mat-form-field>
            <button mat-raised-button color="primary" (click)="saveRetention()" [disabled]="!canSaveRetention">
              Save
            </button>
          </div>
        </mat-card-content>
      </mat-card>
    }

    <!-- Live status banner -->
    @if (currentRun()) {
      <mat-card class="live-banner">
        <mat-card-content>
          <div class="live-header">
            <mat-progress-spinner diameter="20" mode="indeterminate"></mat-progress-spinner>
            <span class="live-title">Running</span>
            <span class="live-elapsed">{{ getElapsed(currentRun()!) }}</span>
          </div>
          <div class="step-list">
            @for (step of currentRun()!.steps ?? []; track step.id) {
              <div class="step-item" [class]="'step-' + step.status">
                @if (step.status === 'success') {
                  <mat-icon class="step-icon done">check_circle</mat-icon>
                } @else if (step.status === 'running') {
                  <mat-icon class="step-icon running">sync</mat-icon>
                } @else if (step.status === 'error') {
                  <mat-icon class="step-icon error">error</mat-icon>
                } @else if (step.status === 'skipped') {
                  <mat-icon class="step-icon skipped">skip_next</mat-icon>
                } @else {
                  <mat-icon class="step-icon pending">radio_button_unchecked</mat-icon>
                }
                <span class="step-name">{{ step.stepName }}</span>
                @if (step.status === 'running') {
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
          <mat-option value="success">Success</mat-option>
          <mat-option value="error">Error</mat-option>
          <mat-option value="skipped">Skipped</mat-option>
          <mat-option value="running">Running</mat-option>
        </mat-select>
      </mat-form-field>
      <span class="total-count">{{ total() }} runs total</span>
    </div>

    <!-- History table -->
    @if (runs().length === 0) {
      <mat-card class="empty-card">
        <p class="empty">No probe runs found.</p>
      </mat-card>
    } @else {
      <table mat-table [dataSource]="runs()" class="full-width runs-table" multiTemplateDataRows>
        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let r">
            <span class="badge" [class]="'badge-status-' + r.status">{{ r.status }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="startedAt">
          <th mat-header-cell *matHeaderCellDef>Started</th>
          <td mat-cell *matCellDef="let r">{{ r.startedAt | date:'short' }}</td>
        </ng-container>

        <ng-container matColumnDef="duration">
          <th mat-header-cell *matHeaderCellDef>Duration</th>
          <td mat-cell *matCellDef="let r">{{ formatDuration(r.durationMs) }}</td>
        </ng-container>

        <ng-container matColumnDef="triggeredBy">
          <th mat-header-cell *matHeaderCellDef>Triggered</th>
          <td mat-cell *matCellDef="let r">
            <span class="badge" [class]="'badge-trigger-' + r.triggeredBy">{{ r.triggeredBy }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="result">
          <th mat-header-cell *matHeaderCellDef>Result</th>
          <td mat-cell *matCellDef="let r">
            @if (r.error) {
              <span class="error-text" [matTooltip]="r.error">{{ r.error | slice:0:80 }}</span>
            } @else if (r.result) {
              <span [matTooltip]="r.result">{{ r.result | slice:0:80 }}</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="steps">
          <th mat-header-cell *matHeaderCellDef>Steps</th>
          <td mat-cell *matCellDef="let r">{{ r._count?.steps ?? 0 }}</td>
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
                      <!-- Step-specific rich output -->
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
                              <button mat-icon-button class="copy-btn" matTooltip="Copy to clipboard"
                                aria-label="Copy result to clipboard"
                                (click)="copyToClipboard(step.detail); $event.stopPropagation()">
                                <mat-icon class="copy-icon">content_copy</mat-icon>
                              </button>
                            </div>
                            @if (step.detail.length > 500 && !isStepExpanded(step.id)) {
                              <pre class="detail-pre">{{ step.detail.slice(0, 500) }}…</pre>
                              <button mat-button class="expand-btn" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                                Show full result ({{ step.detail.length | number }} chars)
                              </button>
                            } @else {
                              @if (getFormattedJson(step.id) !== null) {
                                <pre class="detail-pre detail-pre-json">{{ getFormattedJson(step.id) }}</pre>
                              } @else {
                                <pre class="detail-pre">{{ step.detail }}</pre>
                              }
                              @if (step.detail.length > 500) {
                                <button mat-button class="expand-btn" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                                  Collapse
                                </button>
                              }
                            }
                          </div>
                        </div>
                      } @else if (isEvaluateStep(step)) {
                        <div class="step-output-section">
                          <div class="step-meta-row">
                            <span class="meta-label">Evaluation</span>
                            <span class="eval-result" [class.eval-nonempty]="step.detail.includes('non-empty')"
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
                        <!-- Generic fallback for other steps -->
                        <details class="detail-step-output">
                          <summary>Output</summary>
                          <div class="result-toolbar">
                            <span></span>
                            <button mat-icon-button class="copy-btn" matTooltip="Copy to clipboard"
                              aria-label="Copy step output to clipboard"
                              (click)="copyToClipboard(step.detail); $event.stopPropagation()">
                              <mat-icon class="copy-icon">content_copy</mat-icon>
                            </button>
                          </div>
                          @if (step.detail.length > 500 && !isStepExpanded(step.id)) {
                            <pre class="detail-pre">{{ step.detail.slice(0, 500) }}…</pre>
                            <button mat-button class="expand-btn" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                              Show full output ({{ step.detail.length | number }} chars)
                            </button>
                          } @else {
                            <pre class="detail-pre">{{ step.detail }}</pre>
                            @if (step.detail.length > 500) {
                              <button mat-button class="expand-btn" (click)="toggleStepExpand(step.id); $event.stopPropagation()">
                                Collapse
                              </button>
                            }
                          }
                        </details>
                      }
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
    .page-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 8px 0 0; display: flex; align-items: center; gap: 8px; }
    .back-link { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; color: #1565c0; font-size: 14px; }
    .probe-desc { color: #666; margin: 4px 0 0; }
    .header-actions { display: flex; gap: 8px; align-items: center; }

    .retention-card { margin-bottom: 16px; }
    .retention-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .retention-label { font-weight: 500; font-size: 14px; }
    .retention-field { width: 120px; }

    .live-banner { margin-bottom: 16px; background: #e3f2fd; border-left: 4px solid #1565c0; }
    .live-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .live-title { font-weight: 600; color: #1565c0; }
    .live-elapsed { color: #555; font-size: 13px; }
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
    .badge-active { background: #e8f5e9; color: #2e7d32; }
    .badge-inactive { background: #f5f5f5; color: #777; }
    .badge-status-success { background: #e8f5e9; color: #2e7d32; }
    .badge-status-error { background: #ffebee; color: #c62828; }
    .badge-status-skipped { background: #fff3e0; color: #e65100; }
    .badge-status-running { background: #e3f2fd; color: #1565c0; }
    .badge-status-pending { background: #f5f5f5; color: #777; }
    .badge-trigger-schedule { background: #f3e5f5; color: #7b1fa2; }
    .badge-trigger-manual { background: #e8eaf6; color: #3f51b5; }
    .error-text { color: #c62828; }

    .expanded-detail { padding: 8px 0; }
    .detail-step { padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
    .detail-step:last-child { border-bottom: none; }
    .detail-step-header { display: flex; align-items: center; gap: 8px; }
    .detail-step-order { font-weight: 600; color: #999; min-width: 20px; }
    .detail-step-name { font-weight: 500; }
    .detail-step-duration { font-size: 12px; color: #777; }
    .detail-step-error { margin-top: 4px; padding: 6px 8px; background: #ffebee; color: #c62828; border-radius: 4px; font-size: 13px; }
    .detail-step-output { margin-top: 4px; }
    .detail-step-output summary { cursor: pointer; color: #1565c0; font-size: 12px; }
    .detail-pre { background: #263238; color: #eeffff; padding: 8px 12px; border-radius: 4px; font-size: 12px; overflow-x: auto; max-height: 400px; white-space: pre-wrap; word-break: break-word; margin: 0; }
    .detail-pre-json { color: #c3e88d; }

    .step-output-section { margin-top: 6px; padding: 6px 8px; background: #fafafa; border-radius: 4px; border: 1px solid #e8e8e8; }
    .step-meta-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 13px; }
    .meta-label { font-weight: 500; color: #666; min-width: 90px; flex-shrink: 0; }
    .meta-value { font-size: 12px; color: #333; background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
    .badge-tool { background: #e8eaf6; color: #3f51b5; font-family: monospace; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .badge-system { background: #fff3e0; color: #e65100; font-family: monospace; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .badge-category { background: #f3e5f5; color: #7b1fa2; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }

    .step-result-block { margin-top: 6px; }
    .result-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
    .result-label { font-size: 12px; font-weight: 500; color: #666; }
    .copy-btn { width: 28px; height: 28px; line-height: 28px; }
    .copy-icon { font-size: 16px; width: 16px; height: 16px; }
    .expand-btn { font-size: 11px; color: #1565c0; padding: 0 8px; min-height: 28px; line-height: 28px; }

    .eval-result { font-size: 13px; font-weight: 500; }
    .eval-nonempty { color: #2e7d32; }
    .eval-empty { color: #e65100; }

    .pagination { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 16px 0; }
    .empty { color: #999; text-align: center; padding: 24px 16px; margin: 0; }
    .empty-card { margin-bottom: 16px; }
    .full-width { width: 100%; }
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

  columns = ['status', 'startedAt', 'duration', 'triggeredBy', 'result', 'steps', 'expand'];

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

  toggleExpand(run: ProbeRun): void {
    if (this.expandedRunId === run.id) {
      this.expandedRunId = null;
      this.expandedRun.set(null);
      this.expandedStepIds.clear();
      this.formattedJsonCache.clear();
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
