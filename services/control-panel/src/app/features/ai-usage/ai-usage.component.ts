import { Component, computed, DestroyRef, HostListener, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime } from 'rxjs';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import {
  AiUsageService, AiUsageSummary, AiModelCost, AiUsageLogEntry, AiUsageLogDetail,
} from '../../core/services/ai-usage.service';
import { ModelCostDialogComponent } from './model-cost-dialog.component';
import {
  BroncoButtonComponent,
  SelectComponent,
  TabComponent,
  TabGroupComponent,
  DataTableComponent,
  DataTableColumnComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

interface DatePreset {
  label: string;
  value: string;
  hours: number;
}

/** Tab indexes — keep in sync with the tab-group order in the template. */
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
    MatDialogModule,
    MatPaginatorModule,
    BroncoButtonComponent,
    SelectComponent,
    TabComponent,
    TabGroupComponent,
    DataTableComponent,
    DataTableColumnComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1>AI Usage & Costs</h1>
        <app-bronco-button variant="secondary" (click)="loadAll()">
          ↻ Refresh
        </app-bronco-button>
      </div>

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">

        <!-- ═══ Usage Summary Tab ═══ -->
        <app-tab label="Usage Summary">
          <div class="tab-content">
            <div class="filters">
              <app-select
                [value]="summaryProviderFilter"
                [options]="providerSelectOptions()"
                placeholder=""
                (valueChange)="summaryProviderFilter = $event; loadSummary()">
              </app-select>

              <input class="text-input search-input" type="text"
                     [(ngModel)]="summaryModelFilter" (keyup.enter)="loadSummary()"
                     placeholder="Filter model...">

              <div class="date-presets">
                <span class="date-label">Range:</span>
                @for (preset of datePresets; track preset.value) {
                  <button class="preset-btn" [class.active]="summaryDatePreset === preset.value"
                          (click)="setSummaryDatePreset(preset.value)">
                    {{ preset.label }}
                  </button>
                }
                <button class="preset-btn" [class.active]="summaryDatePreset === 'all'"
                        (click)="setSummaryDatePreset('all')">
                  All
                </button>
              </div>
            </div>

            <div class="stats-row">
              <div class="stat-card">
                <div class="stat-label">Total Cost</div>
                <div class="stat-value cost">\${{ grandTotalCost() | number:'1.4-4' }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Total Calls</div>
                <div class="stat-value">{{ grandTotalCalls() | number }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Total Tokens</div>
                <div class="stat-value">{{ grandTotalTokens() | number }}</div>
              </div>
            </div>

            <app-data-table [data]="usageSummary()" [trackBy]="trackByUsage" [rowClickable]="false"
                            emptyMessage="No AI usage data recorded yet.">
              <app-data-column key="provider" header="Provider" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="model" header="Model" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="mono">{{ row.model }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="calls" header="Calls" [sortable]="false">
                <ng-template #cell let-row>{{ row.callCount | number }}</ng-template>
              </app-data-column>
              <app-data-column key="inputTokens" header="Input Tokens" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="mono">{{ row.totalInputTokens | number }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="outputTokens" header="Output Tokens" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="mono">{{ row.totalOutputTokens | number }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="cost" header="Cost (USD)" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="mono cost-cell">\${{ row.totalCostUsd | number:'1.4-4' }}</span>
                </ng-template>
              </app-data-column>
            </app-data-table>
          </div>
        </app-tab>

        <!-- ═══ Model Costs Tab ═══ -->
        <app-tab label="Model Costs">
          <div class="tab-content">
            <div class="toolbar-row">
              <app-bronco-button variant="primary" (click)="refreshCosts()" [disabled]="loading()">
                ⟳ Refresh Costs
              </app-bronco-button>
              <app-bronco-button variant="secondary" (click)="addModel()">
                + Add Model
              </app-bronco-button>
              @if (loading()) {
                <span class="loading-text">Loading...</span>
              }
            </div>

            <app-data-table [data]="costs()" [trackBy]="trackByCost" [rowClickable]="false"
                            emptyMessage="No model costs configured. Click 'Refresh Costs' to fetch latest pricing or 'Add Model' to add manually.">
              <app-data-column key="provider" header="Provider" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="model" header="Model" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="mono">{{ row.model }}</span>
                  @if (row.isCustomCost) {
                    <span class="custom-badge" title="Custom pricing — protected from refresh updates">*</span>
                  }
                </ng-template>
              </app-data-column>
              <app-data-column key="displayName" header="Display Name" [sortable]="false">
                <ng-template #cell let-row>{{ row.displayName ?? '—' }}</ng-template>
              </app-data-column>
              <app-data-column key="inputCost" header="Input ($/1M)" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="mono">\${{ row.inputCostPer1m | number:'1.2-2' }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="outputCost" header="Output ($/1M)" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="mono">\${{ row.outputCostPer1m | number:'1.2-2' }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="updatedAt" header="Updated" [sortable]="false">
                <ng-template #cell let-row>
                  <span class="time-cell">{{ formatDate(row.updatedAt) }}</span>
                </ng-template>
              </app-data-column>
              <app-data-column key="actions" header="" [sortable]="false" width="160px">
                <ng-template #cell let-row>
                  <div class="action-btns">
                    <app-bronco-button variant="ghost" size="sm" (click)="editModel(row)">Edit</app-bronco-button>
                    @if (row.isCustomCost) {
                      <app-bronco-button variant="ghost" size="sm" (click)="clearCustomCost(row)">Reset</app-bronco-button>
                    }
                    <app-bronco-button variant="ghost" size="sm" (click)="deleteModel(row)">
                      <span class="destructive-text">Delete</span>
                    </app-bronco-button>
                  </div>
                </ng-template>
              </app-data-column>
            </app-data-table>
          </div>
        </app-tab>

        <!-- ═══ Prompt Log Tab ═══ -->
        <app-tab label="Prompt Log">
          <div class="tab-content">
            <!-- Filter row 1: multi-selects + model input -->
            <div class="filters">
              <div class="filter-dropdown" (click)="$event.stopPropagation()">
                <button class="filter-trigger" [class.has-selection]="logProviderFilters.length > 0"
                        (click)="toggleDropdown('provider')">
                  Provider @if (logProviderFilters.length) { ({{ logProviderFilters.length }}) }
                  <span class="chevron">▾</span>
                </button>
                @if (activeDropdown() === 'provider') {
                  <div class="filter-panel">
                    @for (p of providers(); track p) {
                      <label class="filter-option">
                        <input type="checkbox" [checked]="logProviderFilters.includes(p)"
                               (change)="toggleFilterItem('provider', p)">
                        <span>{{ p }}</span>
                      </label>
                    }
                  </div>
                }
                @if (logProviderFilters.length > 0) {
                  <button class="filter-clear" aria-label="Clear provider filter" (click)="logProviderFilters = []; resetAndLoadLogs(); $event.stopPropagation()">×</button>
                }
              </div>

              <input class="text-input search-input" type="text"
                     [(ngModel)]="logModelFilter" (ngModelChange)="modelFilter$.next($event)"
                     (keyup.enter)="resetAndLoadLogs()" placeholder="Filter model...">

              <div class="filter-dropdown" (click)="$event.stopPropagation()">
                <button class="filter-trigger" [class.has-selection]="logTaskTypeFilters.length > 0"
                        (click)="toggleDropdown('taskType')">
                  Task Type @if (logTaskTypeFilters.length) { ({{ logTaskTypeFilters.length }}) }
                  <span class="chevron">▾</span>
                </button>
                @if (activeDropdown() === 'taskType') {
                  <div class="filter-panel">
                    @for (t of allTaskTypes; track t) {
                      <label class="filter-option">
                        <input type="checkbox" [checked]="logTaskTypeFilters.includes(t)"
                               (change)="toggleFilterItem('taskType', t)">
                        <span>{{ t }}</span>
                      </label>
                    }
                  </div>
                }
                @if (logTaskTypeFilters.length > 0) {
                  <button class="filter-clear" aria-label="Clear task type filter" (click)="logTaskTypeFilters = []; resetAndLoadLogs(); $event.stopPropagation()">×</button>
                }
              </div>

              <div class="filter-dropdown" (click)="$event.stopPropagation()">
                <button class="filter-trigger" [class.has-selection]="logPromptKeyFilters.length > 0"
                        (click)="toggleDropdown('promptKey')">
                  Prompt Key @if (logPromptKeyFilters.length) { ({{ logPromptKeyFilters.length }}) }
                  <span class="chevron">▾</span>
                </button>
                @if (activeDropdown() === 'promptKey') {
                  <div class="filter-panel">
                    @for (k of promptKeys(); track k) {
                      <label class="filter-option">
                        <input type="checkbox" [checked]="logPromptKeyFilters.includes(k)"
                               (change)="toggleFilterItem('promptKey', k)">
                        <span>{{ k }}</span>
                      </label>
                    }
                  </div>
                }
                @if (logPromptKeyFilters.length > 0) {
                  <button class="filter-clear" aria-label="Clear prompt key filter" (click)="logPromptKeyFilters = []; resetAndLoadLogs(); $event.stopPropagation()">×</button>
                }
              </div>
            </div>

            <!-- Filter row 2: context, tokens, dates, actions -->
            <div class="filters">
              <input class="text-input search-input" type="text"
                     [(ngModel)]="logContextFilter" (ngModelChange)="contextFilter$.next($event)"
                     (keyup.enter)="resetAndLoadLogs()" placeholder="Search entity type/ID...">

              <input class="text-input token-input" type="number"
                     [(ngModel)]="logMinTokens" (ngModelChange)="tokenFilter$.next()"
                     (keyup.enter)="resetAndLoadLogs()" placeholder="Min tokens">

              <input class="text-input token-input" type="number"
                     [(ngModel)]="logMaxTokens" (ngModelChange)="tokenFilter$.next()"
                     (keyup.enter)="resetAndLoadLogs()" placeholder="Max tokens">

              <div class="date-presets">
                <span class="date-label">Range:</span>
                @for (preset of datePresets; track preset.value) {
                  <button class="preset-btn" [class.active]="logDatePreset === preset.value"
                          (click)="setLogDatePreset(preset.value)">
                    {{ preset.label }}
                  </button>
                }
                <button class="preset-btn" [class.active]="logDatePreset === 'all'"
                        (click)="setLogDatePreset('all')">
                  All
                </button>
              </div>

              <div class="log-actions">
                <app-bronco-button variant="destructive" size="sm"
                                   [disabled]="selectedLogIds().size === 0 && !allMatchingSelected()"
                                   (click)="deleteSelectedLogs()">
                  Delete Selected
                </app-bronco-button>
                <app-bronco-button variant="secondary" size="sm" (click)="refreshLogCosts()" [disabled]="logLoading()"
                                   title="Recalculate costs for log entries missing prices">
                  $ Refresh Costs
                </app-bronco-button>
                @if (logLoading()) {
                  <span class="loading-text">Loading...</span>
                }
              </div>
            </div>

            <!-- Select-all banners -->
            @if (isAllPageSelected() && !allMatchingSelected()) {
              <div class="select-banner">
                All {{ logs().length }} rows on this page are selected.
                <button class="select-banner-link" (click)="allMatchingSelected.set(true)">
                  Select all {{ logTotal() }} rows matching current filters?
                </button>
              </div>
            }
            @if (allMatchingSelected()) {
              <div class="select-banner">
                All {{ logTotal() }} rows matching current filters are selected.
                <button class="select-banner-link" (click)="clearSelection()">Clear selection</button>
              </div>
            }

            <!-- Prompt Log Table -->
            <div class="table-card">
              @if (logs().length === 0) {
                <div class="table-empty">No prompt logs match the current filters.</div>
              } @else {
                <table class="log-table">
                  <thead>
                    <tr>
                      <th class="col-checkbox">
                        <input type="checkbox"
                               [checked]="isAllPageSelected()"
                               [indeterminate]="selectedLogIds().size > 0 && !isAllPageSelected()"
                               (change)="togglePageSelection($any($event.target).checked)"
                               (click)="$event.stopPropagation()">
                      </th>
                      <th class="col-expand"></th>
                      <th>Time</th>
                      <th>Provider</th>
                      <th>Model</th>
                      <th>Task Type</th>
                      <th>Context</th>
                      <th>Tokens</th>
                      <th>Cost</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of logs(); track row.id) {
                      <tr class="log-row" [class.expanded-row]="expandedLogIds().has(row.id)"
                          (click)="toggleLog(row)">
                        <td class="col-checkbox" (click)="$event.stopPropagation()">
                          <input type="checkbox" aria-label="Select log entry"
                                 [checked]="selectedLogIds().has(row.id)"
                                 (change)="toggleRowSelection(row.id, $any($event.target).checked)">
                        </td>
                        <td class="col-expand">
                          <button class="expand-btn"
                                  [title]="expandedLogIds().has(row.id) ? 'Collapse' : 'Show prompt/response'"
                                  [attr.aria-label]="expandedLogIds().has(row.id) ? 'Collapse row' : 'Expand row'"
                                  (click)="toggleLog(row); $event.stopPropagation()">
                            {{ expandedLogIds().has(row.id) ? '▴' : '▾' }}
                          </button>
                        </td>
                        <td class="time-cell">{{ formatTime(row.createdAt) }}</td>
                        <td>
                          <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                        </td>
                        <td class="mono">{{ row.model }}</td>
                        <td>
                          <span class="task-chip">{{ row.taskType }}</span>
                        </td>
                        <td>
                          @if (row.ticketSubject) {
                            <span class="ticket-ref" [title]="row.entityId">{{ row.ticketSubject | slice:0:50 }}{{ row.ticketSubject.length > 50 ? '...' : '' }}</span>
                          } @else if (row.promptKey) {
                            <span class="prompt-key-ref">{{ row.promptKey }}</span>
                          } @else {
                            <span class="muted">—</span>
                          }
                        </td>
                        <td class="mono">
                          <span class="token-in" title="Input tokens">{{ row.inputTokens | number }}</span>
                          /
                          <span class="token-out" title="Output tokens">{{ row.outputTokens | number }}</span>
                        </td>
                        <td class="mono cost-cell">
                          @if (row.costUsd !== null) {
                            \${{ row.costUsd | number:'1.4-4' }}
                          } @else {
                            <span class="muted">—</span>
                          }
                        </td>
                        <td class="mono time-cell">
                          @if (row.durationMs !== null) {
                            {{ row.durationMs | number }}ms
                          } @else {
                            —
                          }
                        </td>
                      </tr>
                      @if (expandedLogIds().has(row.id)) {
                        <tr class="detail-row">
                          <td colspan="10">
                            <div class="log-detail-panel">
                              @if (detailLoading().get(row.id)) {
                                <span class="loading-text">Loading...</span>
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
                                  <p class="detail-error">Failed to load details.</p>
                                }
                              }
                            </div>
                          </td>
                        </tr>
                      }
                    }
                  </tbody>
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
            </div>
          </div>
        </app-tab>

      </app-tab-group>
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

    .tab-content { padding: 0; }

    /* ── Filters ── */
    .filters {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
      align-items: center;
    }

    .text-input {
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .text-input::placeholder { color: var(--text-tertiary); }
    .text-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring);
    }
    .search-input { min-width: 180px; }
    .token-input { max-width: 110px; }

    /* ── Date preset pills ── */
    .date-presets { display: flex; gap: 4px; align-items: center; }
    .date-label {
      font-family: var(--font-primary);
      font-size: 11px;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
      margin-right: 4px;
    }
    .preset-btn {
      padding: 4px 10px;
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 500;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-pill);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 120ms ease;
    }
    .preset-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .preset-btn.active {
      background: var(--bg-active);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }

    /* ── Stats cards ── */
    .stats-row {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .stat-card {
      flex: 1;
      min-width: 180px;
      text-align: center;
      padding: 20px;
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
    }
    .stat-label {
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .stat-value {
      font-family: var(--font-primary);
      font-size: 28px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.5px;
    }
    .stat-value.cost { color: var(--color-success); }

    /* ── Shared table styles ── */
    .mono { font-family: monospace; font-size: 13px; }
    .time-cell {
      font-family: monospace;
      font-size: 12px;
      color: var(--text-tertiary);
      white-space: nowrap;
    }
    .cost-cell { color: var(--color-success); font-weight: 600; }
    .muted { color: var(--text-tertiary); }

    /* ── Provider chips ── */
    .provider-chip {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: monospace;
      font-weight: 600;
    }
    .provider-claude { background: rgba(106, 27, 154, 0.08); color: #6a1b9a; }
    .provider-local { background: rgba(52, 199, 89, 0.08); color: var(--color-success); }
    .provider-openai { background: rgba(0, 113, 227, 0.08); color: var(--accent); }
    .provider-grok { background: rgba(255, 149, 0, 0.08); color: var(--color-warning); }
    .provider-google { background: rgba(52, 199, 89, 0.08); color: var(--color-success); }

    /* ── Task chips ── */
    .task-chip {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-active);
      color: var(--accent);
      font-family: monospace;
      font-weight: 500;
    }

    /* ── Model Costs toolbar ── */
    .toolbar-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
    }
    .action-btns {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .destructive-text { color: var(--color-error); }
    .custom-badge {
      color: var(--color-warning);
      font-weight: 700;
      font-size: 14px;
      margin-left: 4px;
      cursor: help;
    }

    /* ── Loading ── */
    .loading-text {
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-tertiary);
    }

    /* ── Prompt Log actions ── */
    .log-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-left: auto;
    }

    /* ── Multi-select dropdown ── */
    .filter-dropdown {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .filter-trigger {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 8px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      cursor: pointer;
      white-space: nowrap;
      transition: border-color 120ms ease;
    }
    .filter-trigger:hover { border-color: var(--accent); }
    .filter-trigger.has-selection {
      border-color: var(--accent);
      background: var(--bg-active);
    }
    .chevron { font-size: 10px; color: var(--text-tertiary); margin-left: 2px; }
    .filter-panel {
      position: absolute;
      top: 100%;
      left: 0;
      z-index: 100;
      min-width: 220px;
      max-height: 260px;
      overflow-y: auto;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      padding: 4px 0;
      margin-top: 4px;
    }
    .filter-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: background 80ms ease;
    }
    .filter-option:hover { background: var(--bg-hover); }
    .filter-option input[type="checkbox"] { accent-color: var(--accent); }
    .filter-clear {
      background: none;
      border: none;
      color: var(--text-tertiary);
      cursor: pointer;
      padding: 2px 6px;
      font-size: 16px;
      line-height: 1;
      transition: color 80ms ease;
    }
    .filter-clear:hover { color: var(--text-primary); }

    /* ── Select-all banner ── */
    .select-banner {
      background: var(--bg-active);
      padding: 8px 16px;
      text-align: center;
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-secondary);
      border-radius: var(--radius-md);
      margin-bottom: 8px;
    }
    .select-banner-link {
      color: var(--accent-link);
      cursor: pointer;
      text-decoration: underline;
      background: none;
      border: none;
      padding: 0;
      font-family: inherit;
      font-size: inherit;
    }

    /* ── Custom log table ── */
    .table-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      overflow: hidden;
    }
    .table-empty {
      padding: 48px 24px;
      text-align: center;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-tertiary);
    }
    .log-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .log-table thead th {
      text-align: left;
      padding: 10px 12px;
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 500;
      color: var(--text-tertiary);
      border-bottom: 1px solid var(--border-light);
      user-select: none;
    }
    .log-table tbody td {
      padding: 10px 12px;
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-light);
    }
    .col-checkbox { width: 32px; text-align: center; }
    .col-checkbox input[type="checkbox"] { accent-color: var(--accent); }
    .col-expand { width: 32px; }
    .expand-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-tertiary);
      font-size: 14px;
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      transition: background 80ms ease;
    }
    .expand-btn:hover { background: var(--bg-hover); }
    .log-row {
      cursor: pointer;
      transition: background 80ms ease;
    }
    .log-row:hover { background: var(--bg-hover); }
    .expanded-row { background: var(--bg-active) !important; }
    .detail-row td {
      padding: 0 !important;
      border-bottom: none;
    }
    .log-detail-panel { padding: 12px 16px 16px; overflow: hidden; }
    .log-detail-section { margin-bottom: 12px; }
    .log-detail-label {
      font-family: var(--font-primary);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-tertiary);
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .log-detail-text {
      margin: 0;
      padding: 8px;
      background: var(--bg-page);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-md);
      font-size: 12px;
      font-family: monospace;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
      min-width: 250px;
    }
    .detail-error {
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--color-error);
      margin: 0;
    }

    /* ── Ticket/prompt references ── */
    .ticket-ref { font-size: 12px; color: var(--color-warning); cursor: help; }
    .prompt-key-ref { font-size: 12px; color: #6a1b9a; font-family: monospace; }
    .token-in { color: var(--accent); }
    .token-out { color: var(--color-success); }
  `],
})
export class AiUsageComponent implements OnInit {
  private aiUsageService = inject(AiUsageService);
  private toast = inject(ToastService);
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

  // --- Multi-select dropdown state ---
  activeDropdown = signal<string | null>(null);

  // --- DataTable track-by functions ---
  trackByUsage = (row: AiUsageSummary) => `${row.provider}-${row.model}`;
  trackByCost = (row: AiModelCost) => row.id;

  // --- Provider select options (Usage Summary tab) ---
  providerSelectOptions = computed(() => [
    { value: '', label: 'All Providers' },
    ...this.providers().map(p => ({ value: p, label: p }))
  ]);

  @HostListener('document:click')
  closeDropdowns(): void {
    this.activeDropdown.set(null);
  }

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
        this.toast.info(msg);
        this.loadCosts();
      },
      error: (err) => {
        this.loading.set(false);
        this.toast.error(err.error?.error ?? 'Failed to refresh costs');
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
      next: () => { this.toast.success('Deleted'); this.loadCosts(); },
      error: () => this.toast.error('Failed to delete'),
    });
  }

  clearCustomCost(cost: AiModelCost): void {
    this.aiUsageService.clearCustomCost(cost.id).subscribe({
      next: () => { this.toast.success('Custom cost cleared'); this.loadCosts(); },
      error: () => this.toast.error('Failed'),
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
        this.toast.success(`Refreshed costs: ${res.updated} of ${res.total} entries updated`);
        this.loadLogs();
        this.loadSummary();
      },
      error: () => {
        this.logLoading.set(false);
        this.toast.error('Failed to refresh log costs');
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
        this.toast.success(`Deleted ${res.deleted} log entries`);
        this.resetAndLoadLogs();
      },
      error: () => {
        this.logLoading.set(false);
        this.toast.error('Failed to delete logs');
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
        this.toast.error('Failed to load log detail');
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

  // --- Multi-select dropdown helpers ---

  toggleDropdown(name: string): void {
    this.activeDropdown.set(this.activeDropdown() === name ? null : name);
  }

  toggleFilterItem(type: string, value: string): void {
    let arr: string[];
    switch (type) {
      case 'provider': arr = this.logProviderFilters; break;
      case 'taskType': arr = this.logTaskTypeFilters; break;
      case 'promptKey': arr = this.logPromptKeyFilters; break;
      default: return;
    }
    const idx = arr.indexOf(value);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(value);
    this.resetAndLoadLogs();
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
