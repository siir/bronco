import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import {
  AiUsageService, AiUsageSummary, AiModelCost, AiUsageLogEntry, AiUsageLogDetail,
} from '../../core/services/ai-usage.service';
import { ModelCostDialogComponent } from './model-cost-dialog.component';

interface DatePreset {
  label: string;
  value: string;
  hours: number;
}

/** Tab indexes — keep in sync with the mat-tab-group order in the template. */
const TAB_INDEX = {
  USAGE_SUMMARY: 0,
  MODEL_COSTS: 1,
  PROMPT_LOG: 2,
} as const;

/** Maximum number of log detail entries to keep in the client-side cache. */
const MAX_DETAIL_CACHE_SIZE = 100;

/** All known TaskType values from shared-types. Used for the multi-select filter. */
const ALL_TASK_TYPES: string[] = [
  'TRIAGE', 'CATEGORIZE', 'SUMMARIZE', 'DRAFT_EMAIL', 'EXTRACT_FACTS',
  'SUMMARIZE_TICKET', 'SUGGEST_NEXT_STEPS', 'CLASSIFY_INTENT', 'SUMMARIZE_LOGS',
  'GENERATE_TITLE', 'CLASSIFY_EMAIL', 'ANALYZE_WORK_ITEM', 'DRAFT_COMMENT',
  'GENERATE_DEVOPS_PLAN', 'ANALYZE_QUERY', 'GENERATE_SQL', 'REVIEW_CODE', 'DEEP_ANALYSIS',
  'BUG_ANALYSIS', 'ARCHITECTURE_REVIEW', 'SCHEMA_REVIEW', 'FEATURE_ANALYSIS',
  'RESOLVE_ISSUE', 'CHANGE_CODEBASE_SMALL', 'CHANGE_CODEBASE_LARGE',
  'ANALYZE_TICKET_CLOSURE', 'GENERATE_RELEASE_NOTE', 'SUMMARIZE_ROUTE',
  'SELECT_ROUTE',
];

const DATE_PRESETS: DatePreset[] = [
  { label: '24h', value: '24h', hours: 24 },
  { label: '3d', value: '3d', hours: 72 },
  { label: '5d', value: '5d', hours: 120 },
  { label: '7d', value: '7d', hours: 168 },
  { label: '2w', value: '2w', hours: 336 },
  { label: '1m', value: '1m', hours: 720 },
];

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatCheckboxModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatTabsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatPaginatorModule,
  ],
  template: `
    <div class="page-header">
      <h1>AI Usage & Costs</h1>
      <div class="header-actions">
        <button mat-raised-button (click)="loadAll()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </div>
    </div>

    <mat-tab-group [selectedIndex]="selectedTab()" (selectedTabChange)="onTabChange($event.index)">
      <!-- Usage Summary Tab -->
      <mat-tab label="Usage Summary">
        <div class="tab-content">
          <div class="filters">
            <mat-form-field>
              <mat-label>Provider</mat-label>
              <mat-select [(ngModel)]="summaryProviderFilter" (ngModelChange)="loadSummary()">
                <mat-option value="">All Providers</mat-option>
                @for (p of providers(); track p) {
                  <mat-option [value]="p">{{ p }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field class="search-field">
              <mat-label>Model name</mat-label>
              <input matInput [(ngModel)]="summaryModelFilter" (keyup.enter)="loadSummary()" placeholder="Filter model...">
            </mat-form-field>

            <div class="date-presets">
              <span class="date-label">Range:</span>
              @for (preset of datePresets; track preset.value) {
                <button mat-stroked-button
                        [class.active-preset]="summaryDatePreset === preset.value"
                        (click)="setSummaryDatePreset(preset.value)">
                  {{ preset.label }}
                </button>
              }
              <button mat-stroked-button
                      [class.active-preset]="summaryDatePreset === 'all'"
                      (click)="setSummaryDatePreset('all')">
                All
              </button>
            </div>
          </div>

          <div class="stats-cards">
            <mat-card class="stat-card">
              <div class="stat-label">Total Cost</div>
              <div class="stat-value cost">\${{ grandTotalCost() | number:'1.4-4' }}</div>
            </mat-card>
            <mat-card class="stat-card">
              <div class="stat-label">Total Calls</div>
              <div class="stat-value">{{ grandTotalCalls() | number }}</div>
            </mat-card>
            <mat-card class="stat-card">
              <div class="stat-label">Total Tokens</div>
              <div class="stat-value">{{ grandTotalTokens() | number }}</div>
            </mat-card>
          </div>

          <mat-card>
            <h3>Usage by Provider & Model</h3>
            @if (usageSummary().length === 0) {
              <p class="empty">No AI usage data recorded yet.</p>
            } @else {
              <table mat-table [dataSource]="usageSummary()" class="full-width">
                <ng-container matColumnDef="provider">
                  <th mat-header-cell *matHeaderCellDef>Provider</th>
                  <td mat-cell *matCellDef="let row">
                    <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                  </td>
                </ng-container>
                <ng-container matColumnDef="model">
                  <th mat-header-cell *matHeaderCellDef>Model</th>
                  <td mat-cell *matCellDef="let row" class="mono">{{ row.model }}</td>
                </ng-container>
                <ng-container matColumnDef="calls">
                  <th mat-header-cell *matHeaderCellDef>Calls</th>
                  <td mat-cell *matCellDef="let row">{{ row.callCount | number }}</td>
                </ng-container>
                <ng-container matColumnDef="inputTokens">
                  <th mat-header-cell *matHeaderCellDef>Input Tokens</th>
                  <td mat-cell *matCellDef="let row" class="mono">{{ row.totalInputTokens | number }}</td>
                </ng-container>
                <ng-container matColumnDef="outputTokens">
                  <th mat-header-cell *matHeaderCellDef>Output Tokens</th>
                  <td mat-cell *matCellDef="let row" class="mono">{{ row.totalOutputTokens | number }}</td>
                </ng-container>
                <ng-container matColumnDef="cost">
                  <th mat-header-cell *matHeaderCellDef>Cost (USD)</th>
                  <td mat-cell *matCellDef="let row" class="mono cost-cell">\${{ row.totalCostUsd | number:'1.4-4' }}</td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="usageColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: usageColumns;"></tr>
              </table>
            }
          </mat-card>
        </div>
      </mat-tab>

      <!-- Model Costs Tab -->
      <mat-tab label="Model Costs">
        <div class="tab-content">
          <div class="cost-actions">
            <button mat-raised-button color="accent" (click)="refreshCosts()" [disabled]="loading()"
                    matTooltip="Fetch latest models and pricing from OpenRouter + Ollama">
              <mat-icon>sync</mat-icon> Refresh Costs
            </button>
            <button mat-raised-button color="primary" (click)="addModel()">
              <mat-icon>add</mat-icon> Add Model
            </button>
            @if (loading()) {
              <mat-spinner diameter="24"></mat-spinner>
            }
          </div>

          <mat-card>
            @if (costs().length === 0) {
              <p class="empty">No model costs configured. Click "Refresh Costs" to fetch latest pricing or "Add Model" to add manually.</p>
            } @else {
              <table mat-table [dataSource]="costs()" class="full-width">
                <ng-container matColumnDef="provider">
                  <th mat-header-cell *matHeaderCellDef>Provider</th>
                  <td mat-cell *matCellDef="let row">
                    <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                  </td>
                </ng-container>
                <ng-container matColumnDef="model">
                  <th mat-header-cell *matHeaderCellDef>Model</th>
                  <td mat-cell *matCellDef="let row" class="mono">
                    {{ row.model }}
                    @if (row.isCustomCost) {
                      <span class="custom-badge" matTooltip="Custom pricing — protected from refresh updates">*</span>
                    }
                  </td>
                </ng-container>
                <ng-container matColumnDef="displayName">
                  <th mat-header-cell *matHeaderCellDef>Display Name</th>
                  <td mat-cell *matCellDef="let row">{{ row.displayName ?? '—' }}</td>
                </ng-container>
                <ng-container matColumnDef="inputCost">
                  <th mat-header-cell *matHeaderCellDef>Input ($/1M)</th>
                  <td mat-cell *matCellDef="let row" class="mono">\${{ row.inputCostPer1m | number:'1.2-2' }}</td>
                </ng-container>
                <ng-container matColumnDef="outputCost">
                  <th mat-header-cell *matHeaderCellDef>Output ($/1M)</th>
                  <td mat-cell *matCellDef="let row" class="mono">\${{ row.outputCostPer1m | number:'1.2-2' }}</td>
                </ng-container>
                <ng-container matColumnDef="updatedAt">
                  <th mat-header-cell *matHeaderCellDef>Updated</th>
                  <td mat-cell *matCellDef="let row" class="time-cell">{{ formatDate(row.updatedAt) }}</td>
                </ng-container>
                <ng-container matColumnDef="actions">
                  <th mat-header-cell *matHeaderCellDef></th>
                  <td mat-cell *matCellDef="let row">
                    <button mat-icon-button matTooltip="Edit" (click)="editModel(row)">
                      <mat-icon>edit</mat-icon>
                    </button>
                    @if (row.isCustomCost) {
                      <button mat-icon-button matTooltip="Clear custom cost" (click)="clearCustomCost(row)">
                        <mat-icon>lock_open</mat-icon>
                      </button>
                    }
                    <button mat-icon-button color="warn" matTooltip="Delete" (click)="deleteModel(row)">
                      <mat-icon>delete</mat-icon>
                    </button>
                  </td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="costColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: costColumns;" [class.custom-row]="row.isCustomCost"></tr>
              </table>
            }
          </mat-card>
        </div>
      </mat-tab>

      <!-- Prompt Log Tab -->
      <mat-tab label="Prompt Log">
        <div class="tab-content">
          <div class="filters">
            <mat-form-field>
              <mat-label>Provider</mat-label>
              <mat-select [(ngModel)]="logProviderFilters" multiple (ngModelChange)="resetAndLoadLogs()">
                <mat-select-trigger>
                  @if (logProviderFilters.length <= 2) {
                    {{ logProviderFilters.join(', ') }}
                  } @else {
                    {{ logProviderFilters.length }} selected
                  }
                </mat-select-trigger>
                @for (p of providers(); track p) {
                  <mat-option [value]="p">{{ p }}</mat-option>
                }
              </mat-select>
              @if (logProviderFilters.length > 0) {
                <button matSuffix mat-icon-button class="clear-btn" aria-label="Clear" (click)="logProviderFilters = []; resetAndLoadLogs(); $event.stopPropagation()">
                  <mat-icon>close</mat-icon>
                </button>
              }
            </mat-form-field>

            <mat-form-field class="search-field">
              <mat-label>Model name</mat-label>
              <input matInput [(ngModel)]="logModelFilter" (ngModelChange)="modelFilter$.next($event)" (keyup.enter)="resetAndLoadLogs()" placeholder="Filter model...">
            </mat-form-field>

            <mat-form-field>
              <mat-label>Task Type</mat-label>
              <mat-select [(ngModel)]="logTaskTypeFilters" multiple (ngModelChange)="resetAndLoadLogs()">
                <mat-select-trigger>
                  @if (logTaskTypeFilters.length <= 2) {
                    {{ logTaskTypeFilters.join(', ') }}
                  } @else {
                    {{ logTaskTypeFilters.length }} selected
                  }
                </mat-select-trigger>
                @for (t of allTaskTypes; track t) {
                  <mat-option [value]="t">{{ t }}</mat-option>
                }
              </mat-select>
              @if (logTaskTypeFilters.length > 0) {
                <button matSuffix mat-icon-button class="clear-btn" aria-label="Clear" (click)="logTaskTypeFilters = []; resetAndLoadLogs(); $event.stopPropagation()">
                  <mat-icon>close</mat-icon>
                </button>
              }
            </mat-form-field>

            <mat-form-field>
              <mat-label>Prompt Key</mat-label>
              <mat-select [(ngModel)]="logPromptKeyFilters" multiple (ngModelChange)="resetAndLoadLogs()">
                <mat-select-trigger>
                  @if (logPromptKeyFilters.length <= 2) {
                    {{ logPromptKeyFilters.join(', ') }}
                  } @else {
                    {{ logPromptKeyFilters.length }} selected
                  }
                </mat-select-trigger>
                @for (k of promptKeys(); track k) {
                  <mat-option [value]="k">{{ k }}</mat-option>
                }
              </mat-select>
              @if (logPromptKeyFilters.length > 0) {
                <button matSuffix mat-icon-button class="clear-btn" aria-label="Clear" (click)="logPromptKeyFilters = []; resetAndLoadLogs(); $event.stopPropagation()">
                  <mat-icon>close</mat-icon>
                </button>
              }
            </mat-form-field>
          </div>

          <div class="filters">
            <mat-form-field class="search-field">
              <mat-label>Context</mat-label>
              <input matInput [(ngModel)]="logContextFilter" (ngModelChange)="contextFilter$.next($event)" (keyup.enter)="resetAndLoadLogs()" placeholder="Search entity type/ID...">
            </mat-form-field>

            <mat-form-field class="token-field">
              <mat-label>Min tokens</mat-label>
              <input matInput type="number" [(ngModel)]="logMinTokens" (ngModelChange)="tokenFilter$.next()" (keyup.enter)="resetAndLoadLogs()">
            </mat-form-field>

            <mat-form-field class="token-field">
              <mat-label>Max tokens</mat-label>
              <input matInput type="number" [(ngModel)]="logMaxTokens" (ngModelChange)="tokenFilter$.next()" (keyup.enter)="resetAndLoadLogs()">
            </mat-form-field>

            <div class="date-presets">
              <span class="date-label">Range:</span>
              @for (preset of datePresets; track preset.value) {
                <button mat-stroked-button
                        [class.active-preset]="logDatePreset === preset.value"
                        (click)="setLogDatePreset(preset.value)">
                  {{ preset.label }}
                </button>
              }
              <button mat-stroked-button
                      [class.active-preset]="logDatePreset === 'all'"
                      (click)="setLogDatePreset('all')">
                All
              </button>
            </div>

            <div class="log-actions">
              <button mat-raised-button color="warn"
                      [disabled]="selectedLogIds().size === 0 && !allMatchingSelected()"
                      (click)="deleteSelectedLogs()">
                <mat-icon>delete</mat-icon> Delete Selected
              </button>
              <button mat-raised-button color="accent" (click)="refreshLogCosts()" [disabled]="logLoading()"
                      matTooltip="Recalculate costs for log entries missing prices">
                <mat-icon>attach_money</mat-icon> Refresh Costs
              </button>
              @if (logLoading()) {
                <mat-spinner diameter="24"></mat-spinner>
              }
            </div>
          </div>

          @if (isAllPageSelected() && !allMatchingSelected()) {
            <div class="select-all-banner">
              All {{ logs().length }} rows on this page are selected.
              <button type="button" class="select-all-link" (click)="allMatchingSelected.set(true)">Select all {{ logTotal() }} rows matching current filters?</button>
            </div>
          }
          @if (allMatchingSelected()) {
            <div class="select-all-banner">
              All {{ logTotal() }} rows matching current filters are selected.
              <button type="button" class="select-all-link" (click)="clearSelection()">Clear selection</button>
            </div>
          }

          <mat-card>
            @if (logs().length === 0) {
              <p class="empty">No prompt logs match the current filters.</p>
            } @else {
              <table mat-table [dataSource]="logs()" multiTemplateDataRows class="full-width log-table">
                <ng-container matColumnDef="select">
                  <th mat-header-cell *matHeaderCellDef>
                    <mat-checkbox
                      [checked]="isAllPageSelected()"
                      [indeterminate]="selectedLogIds().size > 0 && !isAllPageSelected()"
                      (change)="togglePageSelection($event.checked)"
                      (click)="$event.stopPropagation()">
                    </mat-checkbox>
                  </th>
                  <td mat-cell *matCellDef="let row">
                    <mat-checkbox
                      [checked]="selectedLogIds().has(row.id)"
                      (change)="toggleRowSelection(row.id, $event.checked)"
                      (click)="$event.stopPropagation()">
                    </mat-checkbox>
                  </td>
                </ng-container>
                <ng-container matColumnDef="expand">
                  <th mat-header-cell *matHeaderCellDef></th>
                  <td mat-cell *matCellDef="let row">
                    <button mat-icon-button
                            [matTooltip]="expandedLogIds().has(row.id) ? 'Collapse' : 'Show prompt/response'"
                            [attr.aria-label]="expandedLogIds().has(row.id) ? 'Collapse' : 'Show prompt/response'"
                            (click)="toggleLog(row); $event.stopPropagation()">
                      <mat-icon>{{ expandedLogIds().has(row.id) ? 'expand_less' : 'expand_more' }}</mat-icon>
                    </button>
                  </td>
                </ng-container>
                <ng-container matColumnDef="time">
                  <th mat-header-cell *matHeaderCellDef>Time</th>
                  <td mat-cell *matCellDef="let row" class="time-cell">{{ formatTime(row.createdAt) }}</td>
                </ng-container>
                <ng-container matColumnDef="provider">
                  <th mat-header-cell *matHeaderCellDef>Provider</th>
                  <td mat-cell *matCellDef="let row">
                    <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                  </td>
                </ng-container>
                <ng-container matColumnDef="model">
                  <th mat-header-cell *matHeaderCellDef>Model</th>
                  <td mat-cell *matCellDef="let row" class="mono">{{ row.model }}</td>
                </ng-container>
                <ng-container matColumnDef="taskType">
                  <th mat-header-cell *matHeaderCellDef>Task Type</th>
                  <td mat-cell *matCellDef="let row">
                    <span class="task-chip">{{ row.taskType }}</span>
                  </td>
                </ng-container>
                <ng-container matColumnDef="context">
                  <th mat-header-cell *matHeaderCellDef>Context</th>
                  <td mat-cell *matCellDef="let row">
                    @if (row.ticketSubject) {
                      <span class="ticket-ref" [matTooltip]="row.entityId">{{ row.ticketSubject | slice:0:50 }}{{ row.ticketSubject.length > 50 ? '...' : '' }}</span>
                    } @else if (row.promptKey) {
                      <span class="prompt-key-ref">{{ row.promptKey }}</span>
                    } @else {
                      <span class="text-muted">—</span>
                    }
                  </td>
                </ng-container>
                <ng-container matColumnDef="tokens">
                  <th mat-header-cell *matHeaderCellDef>Tokens</th>
                  <td mat-cell *matCellDef="let row" class="mono">
                    <span class="token-in" matTooltip="Input tokens">{{ row.inputTokens | number }}</span>
                    /
                    <span class="token-out" matTooltip="Output tokens">{{ row.outputTokens | number }}</span>
                  </td>
                </ng-container>
                <ng-container matColumnDef="cost">
                  <th mat-header-cell *matHeaderCellDef>Cost</th>
                  <td mat-cell *matCellDef="let row" class="mono cost-cell">
                    @if (row.costUsd !== null) {
                      \${{ row.costUsd | number:'1.4-4' }}
                    } @else {
                      <span class="text-muted">—</span>
                    }
                  </td>
                </ng-container>
                <ng-container matColumnDef="duration">
                  <th mat-header-cell *matHeaderCellDef>Duration</th>
                  <td mat-cell *matCellDef="let row" class="mono time-cell">
                    @if (row.durationMs !== null) {
                      {{ row.durationMs | number }}ms
                    } @else {
                      —
                    }
                  </td>
                </ng-container>

                <!-- Expandable detail row -->
                <ng-container matColumnDef="expandedDetail">
                  <td mat-cell *matCellDef="let row" [attr.colspan]="logColumns.length">
                    @if (expandedLogIds().has(row.id)) {
                      <div class="log-detail-panel">
                        @if (detailLoading().get(row.id)) {
                          <mat-spinner diameter="20"></mat-spinner>
                        } @else {
                          @if (expandedLogDetails().get(row.id); as detail) {
                            @if (detail.systemPrompt) {
                              <div class="log-detail-section">
                                <div class="log-detail-label">System Prompt</div>
                                <pre class="log-detail-text">{{ detail.systemPrompt }}</pre>
                              </div>
                            }
                            <div class="log-detail-section">
                              <div class="log-detail-label">Prompt</div>
                              <pre class="log-detail-text">{{ detail.promptText ?? '(not stored)' }}</pre>
                            </div>
                            <div class="log-detail-section">
                              <div class="log-detail-label">Response</div>
                              <pre class="log-detail-text">{{ detail.responseText ?? '(not stored)' }}</pre>
                            </div>
                          } @else {
                            <p class="log-detail-error">Failed to load details.</p>
                          }
                        }
                      </div>
                    }
                  </td>
                </ng-container>

                <tr mat-header-row *matHeaderRowDef="logColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: logColumns;" class="log-row"
                    [class.expanded-row]="expandedLogIds().has(row.id)"
                    (click)="toggleLog(row)"></tr>
                <tr mat-row *matRowDef="let row; columns: ['expandedDetail']" class="detail-row"></tr>
              </table>
            }

            <mat-paginator
              [length]="logTotal()"
              [pageSize]="logPageSize"
              [pageIndex]="logPageIndex"
              [pageSizeOptions]="[50, 100, 200]"
              (page)="onLogPage($event)"
              showFirstLastButtons>
            </mat-paginator>
          </mat-card>
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    .tab-content { padding: 16px 0; }
    .filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center; }
    .search-field { min-width: 200px; }
    .date-presets { display: flex; gap: 4px; align-items: center; }
    .date-label { font-size: 12px; color: #666; margin-right: 4px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .date-presets button { min-width: 0; padding: 0 10px; font-size: 12px; line-height: 28px; }
    .active-preset { background: #e3f2fd !important; color: #1565c0 !important; border-color: #1565c0 !important; font-weight: 600; }
    .log-actions { display: flex; gap: 8px; align-items: center; margin-left: auto; }
    .stats-cards { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .stat-card { flex: 1; min-width: 180px; text-align: center; padding: 20px; }
    .stat-label { font-size: 12px; text-transform: uppercase; color: #666; letter-spacing: 0.5px; margin-bottom: 4px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #222; font-family: monospace; }
    .stat-value.cost { color: #2e7d32; }
    .full-width { width: 100%; }
    .mono { font-family: monospace; font-size: 13px; }
    .time-cell { font-family: monospace; font-size: 12px; color: #666; white-space: nowrap; }
    .cost-cell { color: #2e7d32; font-weight: 600; }
    .provider-chip { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-family: monospace; font-weight: 600; }
    .provider-claude { background: #f3e5f5; color: #6a1b9a; }
    .provider-local { background: #e8f5e9; color: #2e7d32; }
    .provider-openai { background: #e3f2fd; color: #1565c0; }
    .provider-grok { background: #fff3e0; color: #e65100; }
    .provider-google { background: #e8f5e9; color: #1b5e20; }
    .task-chip { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #e8eaf6; color: #3f51b5; font-family: monospace; font-weight: 500; }
    .ticket-ref { font-size: 12px; color: #e65100; cursor: help; }
    .prompt-key-ref { font-size: 12px; color: #6a1b9a; font-family: monospace; }
    .text-muted { color: #999; }
    .token-in { color: #1565c0; }
    .token-out { color: #2e7d32; }
    .cost-actions { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
    .empty { color: #999; padding: 16px; text-align: center; }
    h3 { margin: 0 0 12px 0; padding: 16px 16px 0; }
    .custom-badge { color: #e65100; font-weight: 700; font-size: 14px; margin-left: 4px; cursor: help; }
    .custom-row { background: #fff8e1; }
    .log-table { font-size: 13px; }
    .log-row { cursor: pointer; }
    .log-row:hover { background: #f5f5f5; }
    .expanded-row { background: #e8f0fe !important; }
    .detail-row { height: 0; }
    .detail-row td { padding: 0 !important; border-bottom: none; }
    .log-detail-panel { padding: 12px 16px 16px; overflow: hidden; }
    .log-detail-section { margin-bottom: 12px; }
    .log-detail-label { font-size: 11px; font-weight: 700; text-transform: uppercase; color: #666; letter-spacing: 0.5px; margin-bottom: 4px; }
    .log-detail-text { margin: 0; padding: 8px; background: #fafafa; border: 1px solid #e0e0e0; border-radius: 4px; font-size: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; min-width: 250px; }
    .select-all-banner { background: #e3f2fd; padding: 8px 16px; text-align: center; font-size: 13px; border-radius: 4px; margin-bottom: 8px; }
    .select-all-link { color: #1565c0; cursor: pointer; text-decoration: underline; background: none; border: none; padding: 0; font-size: inherit; }
    .token-field { max-width: 120px; }
    .clear-btn { width: 24px; height: 24px; line-height: 24px; }
    .clear-btn mat-icon { font-size: 16px; width: 16px; height: 16px; }
  `],
})
export class AiUsageComponent implements OnInit {
  private aiUsageService = inject(AiUsageService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

  // --- Usage Summary state ---
  usageSummary = signal<AiUsageSummary[]>([]);
  grandTotalCost = signal(0);
  grandTotalCalls = signal(0);
  grandTotalTokens = signal(0);
  summaryProviderFilter = '';
  summaryModelFilter = '';
  summaryDatePreset = 'all';

  // --- Model Costs state ---
  costs = signal<AiModelCost[]>([]);
  loading = signal(false);

  // --- Prompt Log state ---
  logs = signal<AiUsageLogEntry[]>([]);
  logTotal = signal(0);
  logLoading = signal(false);
  logProviderFilters: string[] = [];
  logModelFilter = '';
  logTaskTypeFilters: string[] = [];
  logPromptKeyFilters: string[] = [];
  logContextFilter = '';
  logMinTokens: number | null = null;
  logMaxTokens: number | null = null;
  logDatePreset = '7d';
  logPageSize = 50;
  logPageIndex = 0;
  promptKeys = signal<string[]>([]);
  allTaskTypes = ALL_TASK_TYPES;

  // --- Bulk selection state ---
  selectedLogIds = signal<Set<string>>(new Set());
  allMatchingSelected = signal(false);

  // --- Debounce subjects for text/number inputs ---
  modelFilter$ = new Subject<string>();
  contextFilter$ = new Subject<string>();
  tokenFilter$ = new Subject<void>();

  // --- Log detail (expandable rows — multiple rows can be expanded simultaneously) ---
  expandedLogIds = signal<Set<string>>(new Set());
  expandedLogDetails = signal<Map<string, AiUsageLogDetail>>(new Map());
  detailLoading = signal<Map<string, boolean>>(new Map());
  private detailCache = new Map<string, AiUsageLogDetail>();

  // --- Shared ---
  providers = signal<string[]>([]);
  selectedTab = signal(0);
  datePresets = DATE_PRESETS;
  usageColumns = ['provider', 'model', 'calls', 'inputTokens', 'outputTokens', 'cost'];
  costColumns = ['provider', 'model', 'displayName', 'inputCost', 'outputCost', 'updatedAt', 'actions'];
  logColumns = ['select', 'expand', 'time', 'provider', 'model', 'taskType', 'context', 'tokens', 'cost', 'duration'];

  ngOnInit(): void {
    const tabParam = this.route.snapshot.queryParamMap.get('tab');
    if (tabParam !== null) {
      const tab = Number(tabParam);
      if (Number.isInteger(tab) && tab >= 0 && tab <= 2) this.selectedTab.set(tab);
    }

    // Debounced text/number filters
    this.modelFilter$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.resetAndLoadLogs());
    this.contextFilter$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.resetAndLoadLogs());
    this.tokenFilter$.pipe(debounceTime(300), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.resetAndLoadLogs());

    this.loadAll();
  }

  loadAll(): void {
    this.loadSummary();
    this.loadCosts();
    this.loadCatalog();
    this.loadPromptKeys();
  }

  loadCatalog(): void {
    this.aiUsageService.getCatalog().subscribe(res => {
      this.providers.set(res.providers.map(p => p.provider));
    });
  }

  // --- Usage Summary ---

  loadSummary(): void {
    const params: Record<string, string> = {};
    if (this.summaryProviderFilter) params['provider'] = this.summaryProviderFilter;
    if (this.summaryModelFilter) params['model'] = this.summaryModelFilter;
    const since = this.getDateSince(this.summaryDatePreset);
    if (since) params['since'] = since;

    this.aiUsageService.getSummary(params).subscribe(rows => {
      this.usageSummary.set(rows);
      let cost = 0, calls = 0, tokens = 0;
      for (const r of rows) {
        cost += r.totalCostUsd;
        calls += r.callCount;
        tokens += r.totalInputTokens + r.totalOutputTokens;
      }
      this.grandTotalCost.set(cost);
      this.grandTotalCalls.set(calls);
      this.grandTotalTokens.set(tokens);
    });
  }

  setSummaryDatePreset(preset: string): void {
    this.summaryDatePreset = preset;
    this.loadSummary();
  }

  // --- Model Costs ---

  loadCosts(): void {
    this.aiUsageService.getCosts().subscribe(rows => this.costs.set(rows));
  }

  refreshCosts(): void {
    this.loading.set(true);
    this.aiUsageService.refreshCosts().subscribe({
      next: (res) => {
        this.loading.set(false);
        const msg = `Updated ${res.updated} models` + (res.skipped ? `, skipped ${res.skipped} custom` : '');
        this.snackBar.open(msg, 'OK', { duration: 4000 });
        this.loadCosts();
      },
      error: (err) => {
        this.loading.set(false);
        this.snackBar.open(err.error?.error ?? 'Failed to refresh costs', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  addModel(): void {
    const ref = this.dialog.open(ModelCostDialogComponent, { width: '500px', data: {} });
    ref.afterClosed().subscribe(result => { if (result) this.loadCosts(); });
  }

  editModel(cost: AiModelCost): void {
    const ref = this.dialog.open(ModelCostDialogComponent, { width: '500px', data: { cost } });
    ref.afterClosed().subscribe(result => { if (result) this.loadCosts(); });
  }

  deleteModel(cost: AiModelCost): void {
    if (!confirm(`Delete cost entry for ${cost.provider}/${cost.model}?`)) return;
    this.aiUsageService.deleteCost(cost.id).subscribe({
      next: () => { this.snackBar.open('Deleted', 'OK', { duration: 3000 }); this.loadCosts(); },
      error: () => this.snackBar.open('Failed to delete', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  clearCustomCost(cost: AiModelCost): void {
    this.aiUsageService.clearCustomCost(cost.id).subscribe({
      next: () => { this.snackBar.open('Custom cost cleared', 'OK', { duration: 3000 }); this.loadCosts(); },
      error: () => this.snackBar.open('Failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  // --- Prompt Log ---

  loadLogs(): void {
    const params: Record<string, string | number> = {
      limit: this.logPageSize,
      offset: this.logPageIndex * this.logPageSize,
    };
    if (this.logProviderFilters.length > 0) params['provider'] = this.logProviderFilters.join(',');
    if (this.logModelFilter) params['model'] = this.logModelFilter;
    if (this.logTaskTypeFilters.length > 0) params['taskType'] = this.logTaskTypeFilters.join(',');
    if (this.logPromptKeyFilters.length > 0) params['promptKey'] = this.logPromptKeyFilters.join(',');
    if (this.logContextFilter) params['context'] = this.logContextFilter;
    if (this.logMinTokens !== null) params['minTokens'] = this.logMinTokens;
    if (this.logMaxTokens !== null) params['maxTokens'] = this.logMaxTokens;
    const since = this.getDateSince(this.logDatePreset);
    if (since) params['since'] = since;

    this.aiUsageService.getLogs(params).subscribe(res => {
      this.logs.set(res.logs);
      this.logTotal.set(res.total);
      this.selectedLogIds.set(new Set());
      this.allMatchingSelected.set(false);
      this.expandedLogIds.set(new Set());
      this.expandedLogDetails.set(new Map());
      this.detailLoading.set(new Map());
      this.detailCache.clear();
    });
  }

  loadPromptKeys(): void {
    this.aiUsageService.getPromptKeys().subscribe(keys => this.promptKeys.set(keys));
  }

  resetAndLoadLogs(): void {
    this.logPageIndex = 0;
    this.loadLogs();
  }

  setLogDatePreset(preset: string): void {
    this.logDatePreset = preset;
    this.resetAndLoadLogs();
  }

  onLogPage(event: PageEvent): void {
    this.logPageSize = event.pageSize;
    this.logPageIndex = event.pageIndex;
    this.loadLogs();
  }

  refreshLogCosts(): void {
    this.logLoading.set(true);
    this.aiUsageService.refreshLogCosts().subscribe({
      next: (res) => {
        this.logLoading.set(false);
        this.snackBar.open(`Refreshed costs: ${res.updated} of ${res.total} entries updated`, 'OK', { duration: 4000 });
        this.loadLogs();
        this.loadSummary();
      },
      error: () => {
        this.logLoading.set(false);
        this.snackBar.open('Failed to refresh log costs', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  // --- Selection & bulk delete ---

  isAllPageSelected(): boolean {
    const logsList = this.logs();
    return logsList.length > 0 && this.selectedLogIds().size === logsList.length;
  }

  togglePageSelection(checked: boolean): void {
    if (checked) {
      this.selectedLogIds.set(new Set(this.logs().map(l => l.id)));
    } else {
      this.selectedLogIds.set(new Set());
      this.allMatchingSelected.set(false);
    }
  }

  toggleRowSelection(id: string, checked: boolean): void {
    const next = new Set(this.selectedLogIds());
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
      this.allMatchingSelected.set(false);
    }
    this.selectedLogIds.set(next);
  }

  clearSelection(): void {
    this.selectedLogIds.set(new Set());
    this.allMatchingSelected.set(false);
  }

  deleteSelectedLogs(): void {
    const count = this.allMatchingSelected() ? this.logTotal() : this.selectedLogIds().size;
    if (!confirm(`Delete ${count} log entries? This cannot be undone.`)) return;

    let body: { ids?: string[]; filter?: Record<string, string | number> };
    if (this.allMatchingSelected()) {
      body = { filter: this.buildCurrentFilter() };
    } else {
      body = { ids: [...this.selectedLogIds()] };
    }

    this.logLoading.set(true);
    this.aiUsageService.deleteLogs(body).subscribe({
      next: (res) => {
        this.logLoading.set(false);
        this.snackBar.open(`Deleted ${res.deleted} log entries`, 'OK', { duration: 4000 });
        this.resetAndLoadLogs();
      },
      error: () => {
        this.logLoading.set(false);
        this.snackBar.open('Failed to delete logs', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  private buildCurrentFilter(): Record<string, string | number> {
    const filter: Record<string, string | number> = {};
    if (this.logProviderFilters.length > 0) filter['provider'] = this.logProviderFilters.join(',');
    if (this.logModelFilter) filter['model'] = this.logModelFilter;
    if (this.logTaskTypeFilters.length > 0) filter['taskType'] = this.logTaskTypeFilters.join(',');
    if (this.logPromptKeyFilters.length > 0) filter['promptKey'] = this.logPromptKeyFilters.join(',');
    if (this.logContextFilter) filter['context'] = this.logContextFilter;
    if (this.logMinTokens !== null) filter['minTokens'] = this.logMinTokens;
    if (this.logMaxTokens !== null) filter['maxTokens'] = this.logMaxTokens;
    const since = this.getDateSince(this.logDatePreset);
    if (since) filter['since'] = since;
    return filter;
  }

  toggleLog(row: AiUsageLogEntry): void {
    if (this.expandedLogIds().has(row.id)) {
      const nextIds = new Set(this.expandedLogIds());
      const nextDetails = new Map(this.expandedLogDetails());
      nextIds.delete(row.id);
      nextDetails.delete(row.id);
      this.expandedLogIds.set(nextIds);
      this.expandedLogDetails.set(nextDetails);
      this.setDetailLoading(row.id, false);
      return;
    }
    const cached = this.detailCache.get(row.id);
    if (cached) {
      // Refresh insertion order for LRU eviction: re-insert moves entry to end of Map.
      this.detailCache.delete(row.id);
      this.detailCache.set(row.id, cached);
      const nextIds = new Set(this.expandedLogIds());
      const nextDetails = new Map(this.expandedLogDetails());
      nextIds.add(row.id);
      nextDetails.set(row.id, cached);
      this.expandedLogIds.set(nextIds);
      this.expandedLogDetails.set(nextDetails);
      this.setDetailLoading(row.id, false);
      return;
    }
    const nextIds = new Set(this.expandedLogIds());
    nextIds.add(row.id);
    this.expandedLogIds.set(nextIds);
    this.setDetailLoading(row.id, true);
    const requestedId = row.id;
    this.aiUsageService.getLog(row.id).subscribe({
      next: (detail) => {
        this.setDetailLoading(requestedId, false);
        if (!this.expandedLogIds().has(requestedId)) return;
        // Evict the least-recently-used (first inserted) entry when cache is full.
        if (this.detailCache.size >= MAX_DETAIL_CACHE_SIZE) {
          const oldestEntry = this.detailCache.keys().next();
          if (!oldestEntry.done && oldestEntry.value !== undefined) {
            this.detailCache.delete(oldestEntry.value);
          }
        }
        this.detailCache.set(requestedId, detail);
        const nextDetails = new Map(this.expandedLogDetails());
        nextDetails.set(requestedId, detail);
        this.expandedLogDetails.set(nextDetails);
      },
      error: () => {
        this.setDetailLoading(requestedId, false);
        // Only collapse and notify if the row is still expanded; the user may have
        // already manually collapsed it while the request was in flight.
        if (!this.expandedLogIds().has(requestedId)) return;
        const nextIds = new Set(this.expandedLogIds());
        nextIds.delete(requestedId);
        this.expandedLogIds.set(nextIds);
        this.snackBar.open('Failed to load log detail', 'OK', { duration: 4000, panelClass: 'error-snackbar' });
      },
    });
  }

  private setDetailLoading(id: string, loading: boolean): void {
    const next = new Map(this.detailLoading());
    if (loading) {
      next.set(id, true);
    } else {
      next.delete(id);
    }
    this.detailLoading.set(next);
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    this.router.navigate([], { queryParams: { tab: index }, queryParamsHandling: 'merge', replaceUrl: true });
    if (index === TAB_INDEX.PROMPT_LOG && this.logs().length === 0) {
      this.loadLogs();
    }
  }

  // --- Helpers ---

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  private getDateSince(preset: string): string | null {
    if (preset === 'all') return null;
    const found = DATE_PRESETS.find(p => p.value === preset);
    if (!found) return null;
    const d = new Date();
    d.setHours(d.getHours() - found.hours);
    return d.toISOString();
  }
}
