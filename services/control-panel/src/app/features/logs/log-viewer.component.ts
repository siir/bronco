import { Component, inject, OnInit, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatChipsModule } from '@angular/material/chips';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { EMPTY, Subject, switchMap, timer } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import { LogService, AppLog } from '../../core/services/log.service';

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatChipsModule,
    MatPaginatorModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page-header">
      <h1>Application Logs</h1>
      <button mat-raised-button (click)="load()">
        <mat-icon>refresh</mat-icon> Refresh
      </button>
    </div>

    <div class="filters">
      <mat-form-field>
        <mat-label>Service</mat-label>
        <mat-select [(ngModel)]="serviceFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All Services</mat-option>
          @for (svc of services(); track svc) {
            <mat-option [value]="svc">{{ svc }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field>
        <mat-label>Level</mat-label>
        <mat-select [(ngModel)]="levelFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All Levels</mat-option>
          <mat-option value="DEBUG">DEBUG</mat-option>
          <mat-option value="INFO">INFO</mat-option>
          <mat-option value="WARN">WARN</mat-option>
          <mat-option value="ERROR">ERROR</mat-option>
        </mat-select>
      </mat-form-field>

      <mat-form-field class="search-field">
        <mat-label>Search messages</mat-label>
        <input matInput [(ngModel)]="searchFilter" (keyup.enter)="resetAndLoad()" placeholder="Search...">
      </mat-form-field>

      <mat-form-field>
        <mat-label>Entity ID</mat-label>
        <input matInput [(ngModel)]="entityIdFilter" (keyup.enter)="resetAndLoad()" placeholder="Filter by entity ID">
      </mat-form-field>
    </div>

    <mat-card>
      <table mat-table [dataSource]="logs()" class="full-width log-table" multiTemplateDataRows>
        <ng-container matColumnDef="level">
          <th mat-header-cell *matHeaderCellDef>Level</th>
          <td mat-cell *matCellDef="let log">
            <span class="level level-{{ log.level.toLowerCase() }}">{{ log.level }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="time">
          <th mat-header-cell *matHeaderCellDef>Time</th>
          <td mat-cell *matCellDef="let log" class="time-cell">{{ formatTime(log.createdAt) }}</td>
        </ng-container>

        <ng-container matColumnDef="service">
          <th mat-header-cell *matHeaderCellDef>Service</th>
          <td mat-cell *matCellDef="let log">
            <span class="service-chip">{{ log.service }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="message">
          <th mat-header-cell *matHeaderCellDef>Message</th>
          <td mat-cell *matCellDef="let log" class="message-cell">
            <div class="message-text">{{ log.message }}</div>
            <div class="message-badges">
              @if (log.entityId) {
                <span class="ticket-ref" [matTooltip]="log.entityId">{{ log.entityType ?? 'entity' }}:{{ log.entityId.slice(0, 8) }}</span>
              }
              @if (getAiInfo(log); as ai) {
                <span class="ai-inline-badge" [matTooltip]="ai.provider + ' / ' + ai.model">
                  <mat-icon class="ai-inline-icon">smart_toy</mat-icon>
                  {{ ai.inputTokens + ai.outputTokens | number }} tokens
                </span>
                @if (getAiCost(log) !== null) {
                  <span class="cost-inline-badge">\${{ getAiCost(log) | number:'1.4-4' }}</span>
                }
              }
            </div>
          </td>
        </ng-container>

        <ng-container matColumnDef="expand">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let log">
            @if (hasDetails(log)) {
              <button mat-icon-button (click)="toggleExpand(log.id); $event.stopPropagation()">
                <mat-icon>{{ expandedId() === log.id ? 'expand_less' : 'expand_more' }}</mat-icon>
              </button>
            }
          </td>
        </ng-container>

        <!-- Expanded detail row -->
        <ng-container matColumnDef="expandedDetail">
          <td mat-cell *matCellDef="let log" [attr.colspan]="columns.length">
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
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns;"
            [class.expanded-row]="expandedId() === row.id"
            [class.error-row]="row.level === 'ERROR'"
            [class.warn-row]="row.level === 'WARN'"
            [class.clickable]="hasDetails(row)"
            (click)="hasDetails(row) && toggleExpand(row.id)"></tr>
        <tr mat-row *matRowDef="let row; columns: ['expandedDetail']"
            class="detail-row"
            [class.detail-row-visible]="expandedId() === row.id"></tr>
      </table>

      <mat-paginator
        [length]="total()"
        [pageSize]="pageSize"
        [pageIndex]="pageIndex"
        [pageSizeOptions]="[50, 100, 200]"
        (page)="onPage($event)"
        showFirstLastButtons>
      </mat-paginator>
    </mat-card>

    @if (logs().length === 0) {
      <p class="empty">No logs match the current filters.</p>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .search-field { min-width: 250px; }
    .full-width { width: 100%; }
    .log-table { font-size: 13px; }
    .time-cell { white-space: nowrap; font-family: monospace; font-size: 12px; color: #666; }
    .message-cell { max-width: 600px; }
    .message-text { word-break: break-word; }
    .message-badges { display: flex; align-items: center; gap: 6px; margin-top: 2px; flex-wrap: wrap; }
    .ai-inline-badge { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; padding: 1px 6px; background: #e8eaf6; border-radius: 4px; color: #3f51b5; font-family: monospace; cursor: help; white-space: nowrap; }
    .ai-inline-icon { font-size: 12px; width: 12px; height: 12px; line-height: 12px; color: #5c6bc0; }
    .cost-inline-badge { font-size: 10px; padding: 1px 6px; background: #e8f5e9; border-radius: 4px; color: #2e7d32; font-family: monospace; font-weight: 600; white-space: nowrap; }
    .service-chip { font-size: 11px; padding: 2px 8px; background: #e8eaf6; border-radius: 4px; color: #3f51b5; font-family: monospace; white-space: nowrap; }
    .ticket-ref { font-size: 10px; padding: 1px 6px; background: #fff3e0; border-radius: 4px; color: #e65100; font-family: monospace; margin-left: 8px; cursor: help; }
    .level { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; font-family: monospace; }
    .level-error { background: #ffebee; color: #c62828; }
    .level-warn { background: #fff3e0; color: #e65100; }
    .level-info { background: #e3f2fd; color: #1565c0; }
    .level-debug { background: #f3e5f5; color: #6a1b9a; }
    .error-row { background: #fff8f8; }
    .warn-row { background: #fffaf0; }
    .clickable { cursor: pointer; }
    .clickable:hover { background: #f5f5f5; }
    .expanded-row { border-bottom: none !important; }
    .detail-row { height: 0; }
    .detail-row td { padding: 0 !important; border-bottom: none; }
    .detail-row-visible td { border-bottom: 1px solid #e0e0e0; }
    .detail-panel { padding: 16px 24px; background: #fafafa; overflow: hidden; }
    .detail-section { margin-bottom: 12px; }
    .detail-section:last-child { margin-bottom: 0; }
    .detail-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #666; margin-bottom: 4px; letter-spacing: 0.5px; }
    .error-block pre { background: #ffebee; padding: 10px 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 0; color: #b71c1c; border-left: 3px solid #c62828; }
    .ai-block { }
    .ai-details { background: #e8eaf6; border-radius: 6px; padding: 10px 12px; border-left: 3px solid #3f51b5; }
    .ai-detail-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
    .ai-detail-row:last-child { margin-bottom: 0; }
    .ai-label { font-weight: 600; color: #444; min-width: 120px; }
    .ai-value { color: #222; font-family: monospace; }
    .prompt-key { color: #6a1b9a; }
    .token-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; margin-right: 6px; }
    .token-badge.input { background: #e3f2fd; color: #1565c0; }
    .token-badge.output { background: #e8f5e9; color: #2e7d32; }
    .token-badge.total { background: #f3e5f5; color: #6a1b9a; font-weight: 600; }
    .context-block pre { background: #f5f5f5; padding: 10px 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 0; border-left: 3px solid #bdbdbd; }
    .empty { color: #999; padding: 16px; text-align: center; }
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
  columns = ['level', 'time', 'service', 'message', 'expand'];

  ngOnInit(): void {
    // Support legacy `ticketId` query param for backward compat with existing deep-links
    this.entityIdFilter = this.route.snapshot.queryParams['entityId'] ?? this.route.snapshot.queryParams['ticketId'] ?? '';
    this.serviceFilter = this.route.snapshot.queryParams['service'] ?? '';
    this.levelFilter = this.route.snapshot.queryParams['level'] ?? '';
    this.logService.getServices().subscribe(svcs => this.services.set(svcs));

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

  onPage(event: PageEvent): void {
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
