import { Component, inject, OnInit, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { PaginatorComponent, type PaginatorPageEvent } from '../../shared/components/index.js';
import { EMPTY, Subject, switchMap, timer } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import { LogService, AppLog } from '../../core/services/log.service';
import {
  BroncoButtonComponent,
  SelectComponent,
  TextInputComponent,
  DataTableComponent,
  DataTableColumnComponent,
} from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    PaginatorComponent,
    BroncoButtonComponent,
    SelectComponent,
    TextInputComponent,
    DataTableComponent,
    DataTableColumnComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1>Application Logs</h1>
        <app-bronco-button variant="secondary" (click)="load()">Refresh</app-bronco-button>
      </div>

      <div class="filters">
        <app-select
          [value]="serviceFilter"
          [options]="serviceOptions()"
          placeholder=""
          (valueChange)="serviceFilter = $event; resetAndLoad()">
        </app-select>
        <app-select
          [value]="levelFilter"
          [options]="levelOptions"
          placeholder="Level"
          (valueChange)="levelFilter = $event; resetAndLoad()">
        </app-select>
        <app-text-input
          class="search-field"
          [value]="searchFilter"
          placeholder="Search messages..."
          (valueChange)="searchFilter = $event"
          (keyup.enter)="resetAndLoad()">
        </app-text-input>
        <app-text-input
          [value]="entityIdFilter"
          placeholder="Filter by entity ID"
          (valueChange)="entityIdFilter = $event"
          (keyup.enter)="resetAndLoad()">
        </app-text-input>
      </div>

      <div class="table-card">
        <app-data-table [data]="logs()" [trackBy]="trackById" (rowClick)="hasDetails($event) && toggleExpand($event.id)" emptyMessage="No logs match the current filters.">
          <app-data-column key="level" header="Level" [sortable]="false" width="80px">
            <ng-template #cell let-log>
              <span class="level level-{{ log.level.toLowerCase() }}">{{ log.level }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="time" header="Time" [sortable]="false" width="160px">
            <ng-template #cell let-log>
              <span class="time-cell">{{ formatTime(log.createdAt) }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="service" header="Service" [sortable]="false" width="120px">
            <ng-template #cell let-log>
              <span class="service-chip">{{ log.service }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="message" header="Message" [sortable]="false">
            <ng-template #cell let-log>
              <div class="message-text">{{ log.message }}</div>
              <div class="message-badges">
                @if (log.entityId) {
                  <span class="ticket-ref" [title]="log.entityId">{{ log.entityType ?? 'entity' }}:{{ log.entityId.slice(0, 8) }}</span>
                }
                @if (getAiInfo(log); as ai) {
                  <span class="ai-inline-badge" [title]="ai.provider + ' / ' + ai.model">
                    {{ ai.inputTokens + ai.outputTokens | number }} tokens
                  </span>
                  @if (getAiCost(log) !== null) {
                    <span class="cost-inline-badge">\${{ getAiCost(log) | number:'1.4-4' }}</span>
                  }
                }
              </div>
            </ng-template>
          </app-data-column>

          <app-data-column key="expand" header="" [sortable]="false" width="48px">
            <ng-template #cell let-log>
              @if (hasDetails(log)) {
                <button type="button" class="icon-btn" [attr.aria-label]="expandedId() === log.id ? 'Collapse details' : 'Expand details'" (click)="toggleExpand(log.id); $event.stopPropagation()">
                  {{ expandedId() === log.id ? '−' : '+' }}
                </button>
              }
            </ng-template>
          </app-data-column>
        </app-data-table>

        <!-- Expanded details rendered outside the table -->
        @for (log of logs(); track log.id) {
          @if (expandedId() === log.id) {
            <div class="detail-panel">
              @if (log.error) {
                <div class="detail-section error-block">
                  <div class="detail-label">Error</div>
                  <pre>{{ log.error }}</pre>
                </div>
              }
              @if (getAiInfo(log); as aiInfo) {
                <div class="detail-section ai-block">
                  <div class="detail-label">AI Details</div>
                  <div class="ai-details">
                    <div class="ai-detail-row">
                      <span class="ai-label">Provider / Model:</span>
                      <span class="ai-value">{{ aiInfo.provider }} / {{ aiInfo.model }}</span>
                    </div>
                    @if (aiInfo.taskType) {
                      <div class="ai-detail-row">
                        <span class="ai-label">Task Type:</span>
                        <span class="ai-value">{{ aiInfo.taskType }}</span>
                      </div>
                    }
                    @if (aiInfo.promptKey) {
                      <div class="ai-detail-row">
                        <span class="ai-label">Prompt Key:</span>
                        <span class="ai-value prompt-key">{{ aiInfo.promptKey }}</span>
                      </div>
                    }
                    <div class="ai-detail-row">
                      <span class="ai-label">Tokens:</span>
                      <span class="ai-value">
                        <span class="token-badge input">{{ aiInfo.inputTokens | number }} in</span>
                        <span class="token-badge output">{{ aiInfo.outputTokens | number }} out</span>
                        <span class="token-badge total">{{ aiInfo.inputTokens + aiInfo.outputTokens | number }} total</span>
                      </span>
                    </div>
                    @if (aiInfo.durationMs) {
                      <div class="ai-detail-row">
                        <span class="ai-label">Duration:</span>
                        <span class="ai-value">{{ aiInfo.durationMs | number }}ms</span>
                      </div>
                    }
                  </div>
                </div>
              }
              @if (log.context) {
                <div class="detail-section context-block">
                  <div class="detail-label">Context</div>
                  <pre>{{ formatJson(log.context) }}</pre>
                </div>
              }
            </div>
          }
        }

        <app-paginator
          [length]="total()"
          [pageSize]="pageSize"
          [pageIndex]="pageIndex"
          [pageSizeOptions]="[20, 50, 100, 200]"
          (page)="onPage($event)" />
      </div>
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .page-header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
      font-family: var(--font-primary);
      color: var(--text-primary);
      letter-spacing: -0.28px;
      line-height: 1.14;
    }
    .filters {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .search-field { min-width: 250px; }
    .table-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      overflow: hidden;
    }
    .time-cell {
      white-space: nowrap;
      font-family: monospace;
      font-size: 12px;
      color: var(--text-tertiary);
    }
    .message-text {
      word-break: break-word;
      color: var(--text-secondary);
      font-size: 13px;
    }
    .message-badges {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
      flex-wrap: wrap;
    }
    .ai-inline-badge {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 10px;
      padding: 1px 6px;
      background: rgba(0, 113, 227, 0.08);
      border-radius: var(--radius-sm);
      color: var(--accent);
      font-family: monospace;
      cursor: help;
      white-space: nowrap;
    }
    .cost-inline-badge {
      font-size: 10px;
      padding: 1px 6px;
      background: rgba(52, 199, 89, 0.1);
      border-radius: var(--radius-sm);
      color: var(--color-success);
      font-family: monospace;
      font-weight: 600;
      white-space: nowrap;
    }
    .service-chip {
      font-size: 11px;
      padding: 2px 8px;
      background: rgba(0, 113, 227, 0.08);
      border-radius: var(--radius-sm);
      color: var(--accent);
      font-family: monospace;
      white-space: nowrap;
    }
    .ticket-ref {
      font-size: 10px;
      padding: 1px 6px;
      background: rgba(255, 149, 0, 0.1);
      border-radius: var(--radius-sm);
      color: var(--color-warning);
      font-family: monospace;
      cursor: help;
    }
    .level {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: monospace;
    }
    .level-error { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }
    .level-warn { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .level-info { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .level-debug { background: rgba(0, 0, 0, 0.04); color: var(--text-tertiary); }
    .icon-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      color: var(--text-tertiary);
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      font-weight: 600;
    }
    .icon-btn:hover { background: var(--bg-hover); }
    .detail-panel {
      padding: 16px 24px;
      background: var(--bg-page);
      border-top: 1px solid var(--border-light);
      border-bottom: 1px solid var(--border-light);
      overflow: hidden;
    }
    .detail-section { margin-bottom: 12px; }
    .detail-section:last-child { margin-bottom: 0; }
    .detail-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-tertiary);
      margin-bottom: 4px;
      letter-spacing: 0.5px;
      font-family: var(--font-primary);
    }
    .error-block pre {
      background: rgba(255, 59, 48, 0.06);
      padding: 10px 12px;
      border-radius: var(--radius-md);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      color: var(--color-error);
      border-left: 3px solid var(--color-error);
    }
    .ai-details {
      background: rgba(0, 113, 227, 0.06);
      border-radius: var(--radius-md);
      padding: 10px 12px;
      border-left: 3px solid var(--accent);
    }
    .ai-detail-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      font-size: 12px;
    }
    .ai-detail-row:last-child { margin-bottom: 0; }
    .ai-label {
      font-weight: 600;
      color: var(--text-secondary);
      min-width: 120px;
      font-family: var(--font-primary);
    }
    .ai-value { color: var(--text-primary); font-family: monospace; }
    .prompt-key { color: var(--accent); }
    .token-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      margin-right: 6px;
    }
    .token-badge.input { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .token-badge.output { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .token-badge.total { background: rgba(0, 113, 227, 0.08); color: var(--accent); font-weight: 600; }
    .context-block pre {
      background: var(--bg-muted);
      padding: 10px 12px;
      border-radius: var(--radius-md);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      border-left: 3px solid var(--border-medium);
    }
  `],
})
export class LogViewerComponent implements OnInit, OnDestroy {
  private logService = inject(LogService);
  private route = inject(ActivatedRoute);
  private destroy$ = new Subject<void>();
  /** Emits to trigger an immediate reload (resets the 15s timer via switchMap). */
  private reload$ = new Subject<void>();

  logs = signal<AppLog[]>([]);
  total = signal(0);
  services = signal<string[]>([]);
  expandedId = signal<string | null>(null);

  serviceFilter = '';
  levelFilter = '';
  searchFilter = '';
  entityIdFilter = '';
  pageSize = 100;
  pageIndex = 0;

  levelOptions = [
    { value: '', label: 'All Levels' },
    { value: 'DEBUG', label: 'DEBUG' },
    { value: 'INFO', label: 'INFO' },
    { value: 'WARN', label: 'WARN' },
    { value: 'ERROR', label: 'ERROR' },
  ];

  serviceOptions = signal<Array<{ value: string; label: string }>>([{ value: '', label: 'All Services' }]);

  trackById = (log: AppLog) => log.id;

  ngOnInit(): void {
    // Support legacy `ticketId` query param for backward compat with existing deep-links
    this.entityIdFilter = this.route.snapshot.queryParams['entityId'] ?? this.route.snapshot.queryParams['ticketId'] ?? '';
    this.serviceFilter = this.route.snapshot.queryParams['service'] ?? '';
    this.levelFilter = this.route.snapshot.queryParams['level'] ?? '';
    this.logService.getServices().subscribe(svcs => {
      this.services.set(svcs);
      this.serviceOptions.set([
        { value: '', label: 'All Services' },
        ...svcs.map(s => ({ value: s, label: s })),
      ]);
    });

    // Use switchMap so each reload (or 15s tick) cancels any in-flight request
    this.reload$.pipe(
      switchMap(() => timer(0, 15000)),
      switchMap(() => this.logService.getLogs({
        service: this.serviceFilter || undefined,
        level: this.levelFilter || undefined,
        search: this.searchFilter || undefined,
        entityId: this.entityIdFilter || undefined,
        limit: this.pageSize,
        offset: this.pageIndex * this.pageSize,
      }).pipe(catchError(() => EMPTY))),
      takeUntil(this.destroy$),
    ).subscribe(res => {
      this.logs.set(res.logs);
      this.total.set(res.total ?? 0);
    });

    // Kick off the first load
    this.reload$.next();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  load(): void {
    this.reload$.next();
  }

  resetAndLoad(): void {
    this.pageIndex = 0;
    this.load();
  }

  onPage(event: PaginatorPageEvent): void {
    this.pageSize = event.pageSize;
    this.pageIndex = event.pageIndex;
    this.load();
  }

  toggleExpand(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  hasDetails(log: AppLog): boolean {
    return !!(log.context || log.error);
  }

  getAiCost(log: AppLog): number | null {
    const ctx = log.context;
    if (!ctx || !('costUsd' in ctx) || ctx['costUsd'] == null) return null;
    return Number(ctx['costUsd']);
  }

  getAiInfo(log: AppLog): { provider: string; model: string; taskType?: string; promptKey?: string; inputTokens: number; outputTokens: number; durationMs?: number } | null {
    const ctx = log.context;
    if (!ctx) return null;
    // AI usage log entries have provider + model + inputTokens in context
    if (ctx['provider'] && ctx['model'] && ('inputTokens' in ctx || 'totalTokens' in ctx)) {
      return {
        provider: String(ctx['provider']),
        model: String(ctx['model']),
        taskType: ctx['taskType'] ? String(ctx['taskType']) : undefined,
        promptKey: ctx['promptKey'] ? String(ctx['promptKey']) : undefined,
        inputTokens: Number(ctx['inputTokens'] ?? 0),
        outputTokens: Number(ctx['outputTokens'] ?? 0),
        durationMs: ctx['durationMs'] ? Number(ctx['durationMs']) : undefined,
      };
    }
    return null;
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  formatJson(obj: unknown): string {
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }
}
