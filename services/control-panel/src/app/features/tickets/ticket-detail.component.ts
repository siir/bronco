import { Component, DestroyRef, inject, OnInit, signal, input, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { CommonModule, DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { TicketService, Ticket, TicketEvent, type TicketAppLog, type TicketAiUsageLog } from '../../core/services/ticket.service';
import { LogSummaryService, type LogSummary } from '../../core/services/log-summary.service';
import { AiUsageService, type TicketCostResponse } from '../../core/services/ai-usage.service';
import { AiHelpDialogComponent, type AiHelpDialogData } from '../../shared/components/ai-help-dialog.component';

interface FlowNode {
  label: string;
  icon: string;
  type: 'start' | 'action' | 'ai' | 'email' | 'status' | 'end';
  children?: FlowNode[];
}

@Component({
  standalone: true,
  imports: [CommonModule, RouterLink, DatePipe, JsonPipe, FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule, MatTooltipModule, MatTabsModule],
  template: `
    @if (ticket(); as t) {
      <div class="page-header">
        <div>
          <a routerLink="/tickets" class="back-link">Tickets</a> /
          <h1 class="inline">@if (t.ticketNumber) { <span class="ticket-number">#{{ t.ticketNumber }}</span> — }{{ t.subject }}</h1>
        </div>
      </div>

      <div class="ticket-meta">
        <mat-select [value]="t.priority" (selectionChange)="updateField('priority', $event.value)" class="priority-select" aria-label="Priority">
          <mat-option value="LOW"><span class="priority priority-low">Low</span></mat-option>
          <mat-option value="MEDIUM"><span class="priority priority-medium">Medium</span></mat-option>
          <mat-option value="HIGH"><span class="priority priority-high">High</span></mat-option>
          <mat-option value="CRITICAL"><span class="priority priority-critical">Critical</span></mat-option>
        </mat-select>
        <mat-select [value]="t.status" (selectionChange)="updateStatus($event.value)" class="status-select" aria-label="Status">
          <mat-option value="OPEN">Open</mat-option>
          <mat-option value="IN_PROGRESS">In Progress</mat-option>
          <mat-option value="WAITING">Waiting</mat-option>
          <mat-option value="RESOLVED">Resolved</mat-option>
          <mat-option value="CLOSED">Closed</mat-option>
        </mat-select>
        <mat-select [value]="t.category ?? ''" (selectionChange)="updateField('category', $event.value || null)" class="category-select" aria-label="Category">
          <mat-option value="">None</mat-option>
          <mat-option value="DATABASE_PERF">Database Perf</mat-option>
          <mat-option value="BUG_FIX">Bug Fix</mat-option>
          <mat-option value="FEATURE_REQUEST">Feature Request</mat-option>
          <mat-option value="SCHEMA_CHANGE">Schema Change</mat-option>
          <mat-option value="CODE_REVIEW">Code Review</mat-option>
          <mat-option value="ARCHITECTURE">Architecture</mat-option>
          <mat-option value="GENERAL">General</mat-option>
        </mat-select>
        <span class="source">via {{ t.source }}</span>
        <span class="date">{{ t.createdAt | date:'medium' }}</span>
        <span class="analysis-badge analysis-{{ t.analysisStatus?.toLowerCase() }}">
          @if (t.analysisStatus === 'IN_PROGRESS') {
            <mat-icon class="spin-icon">sync</mat-icon>
          }
          {{ formatAnalysisStatus(t.analysisStatus) }}
          @if (t.analysisStatus === 'COMPLETED' && t.lastAnalyzedAt) {
            <span class="analysis-time">{{ t.lastAnalyzedAt | date:'short' }}</span>
          }
        </span>
        @if (t.analysisStatus === 'FAILED') {
          <button mat-stroked-button color="warn" class="retry-btn" (click)="reanalyze()" [disabled]="reanalyzing()">
            <mat-icon>replay</mat-icon> Retry Analysis
          </button>
        }
      </div>

      @if (t.analysisStatus === 'FAILED' && t.analysisError) {
        <div class="analysis-error">
          <mat-icon>error_outline</mat-icon>
          <span>{{ t.analysisError }}</span>
        </div>
      }

      <!-- Tab group: AI Summary, Resolution Summary, Details, Log Digest -->
      <mat-tab-group class="info-tabs" animationDuration="0ms">
        @if (emailBlurb()) {
          <mat-tab label="AI Summary">
            <div class="tab-content">
              <p class="blurb-text">{{ emailBlurb() }}</p>
            </div>
          </mat-tab>
        }
        @if (t.summary) {
          <mat-tab label="Resolution Summary">
            <div class="tab-content">
              <p class="summary-text">{{ t.summary }}</p>
            </div>
          </mat-tab>
        }
        <mat-tab label="Details">
          <div class="tab-content">
            @if (t.description) {
              <p class="description">{{ truncateDescription(t.description) }}</p>
              @if (t.description.length > 300) {
                <button mat-button class="show-more-btn" (click)="descExpanded = !descExpanded">
                  {{ descExpanded ? 'Show less' : 'Show more' }}
                </button>
              }
            }
            @if (t.system) { <p><strong>System:</strong> {{ t.system.name }}</p> }
            @if (t.client) { <p><strong>Client:</strong> {{ t.client.name }}</p> }
          </div>
        </mat-tab>
        <mat-tab>
          <ng-template mat-tab-label>
            Logs
            @if (ticketLogsTotal() > 0) {
              <span class="tab-badge">{{ ticketLogsTotal() }}</span>
            }
          </ng-template>
          <div class="tab-content">
            <!-- Logs filter bar -->
            <div class="logs-filter-bar">
              <mat-form-field class="logs-filter-field">
                <mat-label>Level</mat-label>
                <mat-select [ngModel]="logsLevelFilter()" (ngModelChange)="logsLevelFilter.set($event); loadTicketLogs()">
                  <mat-option value="">All</mat-option>
                  <mat-option value="ERROR">Error</mat-option>
                  <mat-option value="WARN">Warn</mat-option>
                  <mat-option value="INFO">Info</mat-option>
                  <mat-option value="DEBUG">Debug</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field class="logs-filter-field">
                <mat-label>Search</mat-label>
                <input matInput [ngModel]="logsSearchFilter()" (ngModelChange)="logsSearchFilter.set($event)" (keyup.enter)="loadTicketLogs()">
              </mat-form-field>
              <button mat-icon-button matTooltip="Search" (click)="loadTicketLogs()">
                <mat-icon>search</mat-icon>
              </button>
              <button mat-icon-button matTooltip="Refresh" (click)="loadTicketLogs()">
                <mat-icon>refresh</mat-icon>
              </button>
            </div>

            @if (ticketLogsLoading()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }

            <!-- AI Usage summary (if any) -->
            @if (ticketAiUsageLogs().length > 0) {
              <div class="logs-ai-section">
                <h4 class="logs-section-title"><mat-icon class="section-icon">psychology</mat-icon> AI Calls ({{ ticketAiUsageLogs().length }})</h4>
                <div class="ai-usage-list">
                  @for (usage of ticketAiUsageLogs(); track usage.id) {
                    <div class="ai-usage-row">
                      <span class="ai-usage-time" [matTooltip]="usage.createdAt">{{ formatTime(usage.createdAt) }}</span>
                      <span class="meta-chip provider-chip provider-{{ usage.provider.toLowerCase() }}">{{ usage.provider }}</span>
                      <code class="meta-chip model-chip">{{ usage.model }}</code>
                      <span class="meta-chip task-chip">{{ usage.taskType }}</span>
                      <span class="meta-chip token-chip">{{ usage.inputTokens | number }}in / {{ usage.outputTokens | number }}out</span>
                      @if (usage.durationMs != null) {
                        <span class="meta-chip duration-chip">{{ usage.durationMs | number }}ms</span>
                      }
                      @if (usage.costUsd != null) {
                        <span class="ai-usage-cost">\${{ usage.costUsd | number:'1.4-4' }}</span>
                      }
                    </div>
                  }
                </div>
              </div>
            }

            <!-- App logs list -->
            <div class="logs-list">
              @for (log of ticketLogs(); track log.id) {
                <div class="log-entry log-level-{{ log.level.toLowerCase() }}">
                  <div class="log-entry-header">
                    <span class="log-time" [matTooltip]="log.createdAt">{{ formatTime(log.createdAt) }}</span>
                    <span class="log-level-badge log-badge-{{ log.level.toLowerCase() }}">{{ log.level }}</span>
                    <span class="log-service">{{ log.service }}</span>
                    <span class="log-message">{{ log.message }}</span>
                  </div>
                  @if (log.context && hasKeys(log.context)) {
                    <button mat-button class="log-expand-btn" (click)="expandedLogs[log.id] = !expandedLogs[log.id]">
                      {{ expandedLogs[log.id] ? 'Hide metadata' : 'Show metadata' }}
                      <mat-icon>{{ expandedLogs[log.id] ? 'expand_less' : 'expand_more' }}</mat-icon>
                    </button>
                    @if (expandedLogs[log.id]) {
                      <pre class="log-metadata">{{ log.context | json }}</pre>
                    }
                  }
                  @if (log.error) {
                    <div class="log-error-detail">{{ log.error }}</div>
                  }
                </div>
              } @empty {
                @if (!ticketLogsLoading()) {
                  <p class="empty">No logs found for this ticket.</p>
                }
              }
            </div>

            <!-- Pagination -->
            @if (ticketLogsTotal() > ticketLogs().length) {
              <div class="logs-pagination">
                <span class="logs-showing">Showing {{ ticketLogs().length }} of {{ ticketLogsTotal() }}</span>
                <button mat-stroked-button (click)="loadMoreLogs()">Load more</button>
              </div>
            }
          </div>
        </mat-tab>
        <mat-tab>
          <ng-template mat-tab-label>
            Log Digest
            <button mat-icon-button class="tab-action-btn" (click)="generateLogSummary(); $event.stopPropagation()" [disabled]="generatingLogs()" [matTooltip]="'Summarize recent logs'">
              <mat-icon>{{ generatingLogs() ? 'hourglass_empty' : 'auto_awesome' }}</mat-icon>
            </button>
          </ng-template>
          <div class="tab-content">
            @if (generatingLogs()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }
            @for (ls of logSummaries(); track ls.id) {
              <div class="log-summary-entry">
                <div class="log-summary-header">
                  <span class="log-summary-time">
                    {{ formatTime(ls.windowStart) }} — {{ formatTime(ls.windowEnd) }}
                  </span>
                  <span class="log-summary-count" [matTooltip]="ls.logCount + ' log entries'">
                    {{ ls.logCount }} logs
                  </span>
                </div>
                <p class="log-summary-text">{{ ls.summary }}</p>
                <div class="log-summary-services">
                  @for (svc of ls.services; track svc) {
                    <span class="service-chip">{{ svc }}</span>
                  }
                </div>
              </div>
            } @empty {
              <p class="empty">No log summaries yet. Click the sparkle button to generate one.</p>
            }
          </div>
        </mat-tab>
      </mat-tab-group>

      <!-- Process Flow -->
      @if (flowNodes().length > 0) {
        <mat-card class="flow-card">
          <mat-card-header>
            <mat-icon mat-card-avatar>account_tree</mat-icon>
            <mat-card-title>Process Flow</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <div class="flow-container">
              @for (node of flowNodes(); track node.type + ':' + node.label + ':' + $index; let i = $index) {
                <div class="flow-node flow-{{ node.type }}">
                  <mat-icon class="flow-icon">{{ node.icon }}</mat-icon>
                  <span class="flow-label">{{ node.label }}</span>
                </div>
                @if (node.children && node.children.length > 0) {
                  <div class="flow-branch">
                    @for (child of node.children; track child.type + ':' + child.label + ':' + $index; let j = $index) {
                      <div class="flow-branch-row">
                        <div class="flow-connector"></div>
                        <div class="flow-node flow-{{ child.type }}">
                          <mat-icon class="flow-icon">{{ child.icon }}</mat-icon>
                          <span class="flow-label">{{ child.label }}</span>
                        </div>
                        @if (child.children && child.children.length > 0) {
                          @for (grandchild of child.children; track grandchild.type + ':' + grandchild.label + ':' + $index) {
                            <div class="flow-connector"></div>
                            <div class="flow-node flow-{{ grandchild.type }}">
                              <mat-icon class="flow-icon">{{ grandchild.icon }}</mat-icon>
                              <span class="flow-label">{{ grandchild.label }}</span>
                            </div>
                          }
                        }
                      </div>
                    }
                  </div>
                }
                @if (i < flowNodes().length - 1 && !node.children?.length) {
                  <div class="flow-arrow">
                    <mat-icon>arrow_forward</mat-icon>
                  </div>
                }
              }
            </div>
          </mat-card-content>
        </mat-card>
      }

      <!-- AI Cost with expandable breakdown -->
      @if (ticketCost(); as cost) {
        @if (cost.callCount > 0) {
          <mat-card class="cost-card">
            <mat-card-header>
              <mat-icon mat-card-avatar>analytics</mat-icon>
              <mat-card-title>AI Cost</mat-card-title>
            </mat-card-header>
            <mat-card-content>
              <div class="cost-summary">
                <div class="cost-item">
                  <span class="cost-label">Total Cost</span>
                  <span class="cost-value">\${{ cost.totalCostUsd | number:'1.4-4' }}</span>
                </div>
                <div class="cost-item">
                  <span class="cost-label">AI Calls</span>
                  <span class="cost-value">{{ cost.callCount | number }}</span>
                </div>
                <div class="cost-item">
                  <span class="cost-label">Input Tokens</span>
                  <span class="cost-value">{{ cost.totalInputTokens | number }}</span>
                </div>
                <div class="cost-item">
                  <span class="cost-label">Output Tokens</span>
                  <span class="cost-value">{{ cost.totalOutputTokens | number }}</span>
                </div>
              </div>

              @if (cost.breakdown.length > 0) {
                <button mat-button class="show-details-btn" (click)="costDetailsExpanded = !costDetailsExpanded">
                  {{ costDetailsExpanded ? 'Hide details' : 'Show details' }}
                  <mat-icon>{{ costDetailsExpanded ? 'expand_less' : 'expand_more' }}</mat-icon>
                </button>
              }

              @if (costDetailsExpanded) {
                <div class="cost-breakdown">
                  @for (item of cost.breakdown; track item.provider + ':' + item.model) {
                    <div class="breakdown-group">
                      <div class="breakdown-header">
                        <span class="provider-chip provider-{{ item.provider.toLowerCase() }}">{{ item.provider }}</span>
                        <code class="model-name">{{ item.model }}</code>
                        <span class="breakdown-stats">
                          {{ item.callCount }} calls &middot;
                          \${{ item.totalCostUsd | number:'1.4-4' }}
                        </span>
                      </div>
                      @if (item.calls && item.calls.length > 0) {
                        <div class="call-list">
                          @for (call of item.calls; track call.id) {
                            <div class="call-row">
                              <span class="call-task">{{ call.taskType }}</span>
                              <span class="call-tokens">{{ call.inputTokens | number }}in / {{ call.outputTokens | number }}out</span>
                              @if (call.costUsd != null) {
                                <span class="call-cost">\${{ call.costUsd | number:'1.4-4' }}</span>
                              }
                              @if (call.durationMs != null) {
                                <span class="call-duration">{{ call.durationMs }}ms</span>
                              }
                              <span class="call-time">{{ call.createdAt | date:'shortTime' }}</span>
                            </div>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </mat-card-content>
          </mat-card>
        }
      }

      <!-- Timeline with filter and sort controls -->
      <div class="timeline-header">
        <h3>Timeline</h3>
        <div class="timeline-controls">
          <mat-form-field class="timeline-filter-field">
            <mat-label>Filter</mat-label>
            <mat-select [ngModel]="timelineFilter()" (ngModelChange)="timelineFilter.set($event)">
              <mat-option value="">All Events</mat-option>
              <mat-option value="COMMENT">Comments</mat-option>
              <mat-option value="AI_ANALYSIS">AI Analysis</mat-option>
              <mat-option value="STATUS_CHANGE">Status Changes</mat-option>
              <mat-option value="EMAIL_INBOUND">Inbound Emails</mat-option>
              <mat-option value="EMAIL_OUTBOUND">Outbound Emails</mat-option>
              <mat-option value="CODE_CHANGE">Code Changes</mat-option>
              <mat-option value="SYSTEM_NOTE">System Notes</mat-option>
            </mat-select>
          </mat-form-field>
          <button mat-icon-button [matTooltip]="timelineSortAsc() ? 'Oldest first' : 'Newest first'" (click)="toggleTimelineSort()">
            <mat-icon>{{ timelineSortAsc() ? 'arrow_upward' : 'arrow_downward' }}</mat-icon>
          </button>
        </div>
      </div>
      <div class="timeline">
        @for (event of filteredEvents(); track event.id) {
          <mat-card class="event-card">
            <mat-card-content>
              <div class="event-header">
                <mat-icon>{{ eventIcon(event.eventType) }}</mat-icon>
                <strong>{{ event.eventType }}</strong>
                <span class="event-actor">by {{ event.actor }}</span>
                <span class="event-date">{{ event.createdAt | date:'short' }}</span>
              </div>
              <!-- AI help question (if present in metadata) -->
              @if (eventQuestion(event); as q) {
                <div class="event-question">
                  <mat-icon class="question-icon">help_outline</mat-icon>
                  <span>{{ q }}</span>
                </div>
              }
              <!-- AI metadata chips -->
              @if (eventMeta(event); as meta) {
                @if (meta.aiProvider || meta.aiModel) {
                  <div class="event-ai-meta">
                    @if (meta.aiProvider) {
                      <span class="meta-chip provider-chip provider-{{ meta.aiProvider.toLowerCase() }}">{{ meta.aiProvider }}</span>
                    }
                    @if (meta.aiModel) {
                      <code class="meta-chip model-chip">{{ meta.aiModel }}</code>
                    }
                    @if (meta.phase) {
                      <span class="meta-chip phase-chip">{{ meta.phase }}</span>
                    }
                    @if (meta.taskType) {
                      <span class="meta-chip task-chip">{{ meta.taskType }}</span>
                    }
                    @if (meta.inputTokens != null) {
                      <span class="meta-chip token-chip">{{ meta.inputTokens | number }}in / {{ meta.outputTokens | number }}out</span>
                    }
                    @if (meta.durationMs != null) {
                      <span class="meta-chip duration-chip">{{ meta.durationMs }}ms</span>
                    }
                  </div>
                }
              }
              @if (event.content) {
                <p class="event-content" [class.collapsed]="!expandedEvents[event.id] && event.content.length > 500">
                  {{ expandedEvents[event.id] ? event.content : event.content.slice(0, 500) }}
                  @if (event.content.length > 500 && !expandedEvents[event.id]) {
                    <span class="ellipsis">...</span>
                  }
                </p>
                @if (event.content.length > 500) {
                  <button mat-button class="show-more-btn" (click)="expandedEvents[event.id] = !expandedEvents[event.id]">
                    {{ expandedEvents[event.id] ? 'Show less' : 'Show more' }}
                  </button>
                }
              }
            </mat-card-content>
          </mat-card>
        } @empty {
          <p class="empty">No events match the current filter.</p>
        }
      </div>

      <mat-card class="add-comment">
        <mat-card-content>
          <mat-form-field class="full-width">
            <mat-label>Add comment</mat-label>
            <textarea matInput [(ngModel)]="newComment" rows="2"></textarea>
          </mat-form-field>
          <button mat-raised-button color="primary" (click)="addComment()" [disabled]="!newComment">
            <mat-icon>send</mat-icon> Add Comment
          </button>
        </mat-card-content>
      </mat-card>

      <!-- Re-run Analysis button -->
      <div class="reanalyze-bar">
        <button mat-stroked-button (click)="reanalyze()" [disabled]="reanalyzing()">
          <mat-icon>replay</mat-icon> Re-run Analysis
        </button>
      </div>

      <!-- Floating AI Help button -->
      <button mat-fab class="ai-fab" color="accent" (click)="openAiHelp()" matTooltip="Ask AI for Help">
        <mat-icon>psychology</mat-icon>
      </button>
    } @else {
      <p>Loading...</p>
    }
  `,
  styles: [`
    .page-header { margin-bottom: 16px; }
    .back-link { text-decoration: none; color: #666; }
    .inline { display: inline; margin: 0 8px 0 4px; }
    .ticket-number { color: #666; font-family: monospace; }
    .ticket-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .priority { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .priority-critical { background: #ffebee; color: #c62828; }
    .priority-high { background: #fff3e0; color: #e65100; }
    .priority-medium { background: #e3f2fd; color: #1565c0; }
    .priority-low { background: #e8f5e9; color: #2e7d32; }
    .source { color: #666; font-size: 13px; }
    .date { color: #999; font-size: 13px; }
    .status-select { width: 130px; font-size: 13px; }
    .priority-select { width: 120px; font-size: 13px; }
    .category-select { width: 160px; font-size: 13px; }

    /* Analysis status */
    .analysis-badge { font-size: 11px; font-weight: 500; padding: 2px 10px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; }
    .analysis-pending { background: #f5f5f5; color: #666; }
    .analysis-in_progress { background: #e3f2fd; color: #1565c0; }
    .analysis-completed { background: #e8f5e9; color: #2e7d32; }
    .analysis-failed { background: #ffebee; color: #c62828; }
    .analysis-skipped { background: #f5f5f5; color: #999; }
    .analysis-time { font-size: 10px; color: inherit; opacity: 0.8; margin-left: 4px; }
    .spin-icon { font-size: 14px; width: 14px; height: 14px; animation: spin 1.5s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .retry-btn { font-size: 12px; }
    .analysis-error { display: flex; align-items: flex-start; gap: 8px; background: #ffebee; color: #c62828; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; line-height: 1.4; }
    .analysis-error mat-icon { flex-shrink: 0; font-size: 20px; width: 20px; height: 20px; }

    /* Tab group */
    .info-tabs { margin-bottom: 16px; }
    .tab-content { padding: 16px 0; }
    .tab-action-btn { margin-left: 4px; }
    .tab-action-btn mat-icon { font-size: 16px; width: 16px; height: 16px; }
    .blurb-text { line-height: 1.5; margin: 0; }
    .summary-text { white-space: pre-wrap; line-height: 1.6; }
    .description { white-space: pre-wrap; }
    .show-more-btn { font-size: 12px; color: #3f51b5; padding: 0; min-width: auto; }

    /* Log digest */
    .log-summary-entry { padding: 12px 0; border-bottom: 1px solid #eee; }
    .log-summary-entry:last-child { border-bottom: none; }
    .log-summary-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .log-summary-time { font-size: 12px; color: #666; }
    .log-summary-count { font-size: 11px; color: #666; background: #f0f0f0; padding: 2px 8px; border-radius: 12px; }
    .log-summary-text { margin: 4px 0 8px; line-height: 1.5; color: #333; }
    .log-summary-services { display: flex; gap: 4px; flex-wrap: wrap; }
    .service-chip { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #e8eaf6; color: #3f51b5; }

    /* Logs tab */
    .tab-badge { font-size: 10px; background: #e0e0e0; color: #333; padding: 1px 6px; border-radius: 10px; margin-left: 6px; font-weight: 500; }
    .logs-filter-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .logs-filter-field { width: 140px; font-size: 13px; }
    .logs-ai-section { margin-bottom: 16px; }
    .logs-section-title { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; margin: 0 0 8px; color: #333; }
    .section-icon { font-size: 18px; width: 18px; height: 18px; color: #666; }
    .ai-usage-list { display: flex; flex-direction: column; gap: 4px; }
    .ai-usage-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 8px; background: #fafafa; border-radius: 4px; flex-wrap: wrap; }
    .ai-usage-time { color: #999; font-size: 11px; min-width: 100px; font-family: monospace; }
    .ai-usage-cost { color: #2e7d32; font-weight: 500; font-family: monospace; font-size: 11px; margin-left: auto; }
    .logs-list { display: flex; flex-direction: column; gap: 2px; }
    .log-entry { padding: 6px 10px; border-radius: 4px; border-left: 3px solid transparent; }
    .log-level-error { border-left-color: #c62828; background: #fff8f8; }
    .log-level-warn { border-left-color: #e65100; background: #fffaf5; }
    .log-level-info { border-left-color: #1565c0; background: #f8fbff; }
    .log-level-debug { border-left-color: #999; background: #fafafa; }
    .log-entry-header { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
    .log-time { color: #999; font-family: monospace; font-size: 11px; min-width: 100px; flex-shrink: 0; }
    .log-level-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; }
    .log-badge-error { background: #ffebee; color: #c62828; }
    .log-badge-warn { background: #fff3e0; color: #e65100; }
    .log-badge-info { background: #e3f2fd; color: #1565c0; }
    .log-badge-debug { background: #f5f5f5; color: #999; }
    .log-service { color: #6a1b9a; font-weight: 500; font-size: 11px; }
    .log-message { color: #333; flex: 1; word-break: break-word; }
    .log-expand-btn { font-size: 11px; color: #666; padding: 0; min-width: auto; margin-top: 2px; }
    .log-expand-btn mat-icon { font-size: 14px; width: 14px; height: 14px; }
    .log-metadata { font-size: 11px; background: #f5f5f5; padding: 8px; border-radius: 4px; margin: 4px 0 0; overflow-x: auto; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
    .log-error-detail { font-size: 11px; color: #c62828; margin-top: 4px; white-space: pre-wrap; }
    .logs-pagination { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee; }
    .logs-showing { font-size: 12px; color: #666; }

    /* Process flow */
    .flow-card { margin-bottom: 16px; }
    .flow-container { display: flex; align-items: flex-start; gap: 4px; flex-wrap: wrap; padding: 8px 0; overflow-x: auto; }
    .flow-node { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 16px; font-size: 11px; font-weight: 500; white-space: nowrap; }
    .flow-start { background: #e3f2fd; color: #1565c0; }
    .flow-action { background: #f3e5f5; color: #6a1b9a; }
    .flow-ai { background: #fce4ec; color: #c62828; }
    .flow-email { background: #e8f5e9; color: #2e7d32; }
    .flow-status { background: #fff3e0; color: #e65100; }
    .flow-end { background: #f5f5f5; color: #666; }
    .flow-icon { font-size: 14px; width: 14px; height: 14px; }
    .flow-arrow { color: #bbb; display: flex; align-items: center; }
    .flow-arrow mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .flow-branch { display: flex; flex-direction: column; gap: 4px; margin-left: 8px; padding-left: 8px; border-left: 2px solid #ddd; }
    .flow-branch-row { display: flex; align-items: center; gap: 4px; }
    .flow-connector { width: 12px; height: 2px; background: #ddd; }

    /* AI Cost */
    .cost-card { margin-bottom: 16px; background: #e8f5e9; }
    .cost-summary { display: flex; gap: 24px; flex-wrap: wrap; }
    .cost-item { display: flex; flex-direction: column; }
    .cost-label { font-size: 11px; text-transform: uppercase; color: #666; letter-spacing: 0.5px; }
    .cost-value { font-size: 20px; font-weight: 600; font-family: monospace; color: #222; }
    .show-details-btn { font-size: 12px; margin-top: 8px; color: #2e7d32; }
    .cost-breakdown { margin-top: 12px; border-top: 1px solid rgba(0,0,0,0.1); padding-top: 12px; }
    .breakdown-group { margin-bottom: 12px; }
    .breakdown-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .breakdown-stats { font-size: 12px; color: #666; margin-left: auto; font-family: monospace; }
    .call-list { padding-left: 16px; }
    .call-row { display: flex; gap: 12px; align-items: center; font-size: 12px; padding: 2px 0; font-family: monospace; color: #555; }
    .call-task { font-weight: 500; color: #333; min-width: 140px; font-family: inherit; }
    .call-tokens { color: #666; }
    .call-cost { color: #2e7d32; font-weight: 500; }
    .call-duration { color: #999; }
    .call-time { color: #999; margin-left: auto; }

    /* Timeline header and controls */
    .timeline-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .timeline-header h3 { margin: 0; }
    .timeline-controls { display: flex; align-items: center; gap: 8px; }
    .timeline-filter-field { width: 160px; font-size: 13px; }

    /* Timeline */
    .timeline { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
    .event-header { display: flex; align-items: center; gap: 8px; }
    .event-actor { color: #666; font-size: 13px; }
    .event-date { color: #999; font-size: 13px; margin-left: auto; }
    .event-question { display: flex; align-items: flex-start; gap: 4px; margin-top: 6px; padding: 6px 10px; background: #e3f2fd; border-radius: 6px; font-size: 13px; color: #1565c0; }
    .question-icon { font-size: 16px; width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; }
    .event-content { margin-top: 8px; white-space: pre-wrap; line-height: 1.5; }
    .event-content.collapsed { max-height: 100px; overflow: hidden; }
    .ellipsis { color: #999; }
    .event-ai-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
    .meta-chip { font-size: 10px; padding: 1px 6px; border-radius: 4px; display: inline-block; }
    .provider-chip { font-weight: 600; font-family: monospace; background: #f5f5f5; color: #333; }
    .provider-local { background: #e8f5e9; color: #2e7d32; }
    .provider-claude { background: #f3e5f5; color: #6a1b9a; }
    .provider-openai { background: #e3f2fd; color: #1565c0; }
    .provider-grok { background: #fff3e0; color: #e65100; }
    .provider-google { background: #e8f5e9; color: #1b5e20; }
    .model-chip { background: #f5f5f5; color: #333; font-size: 10px; }
    .model-name { font-size: 12px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    .phase-chip { background: #e8eaf6; color: #3f51b5; }
    .task-chip { background: #fce4ec; color: #c62828; }
    .token-chip { background: #f5f5f5; color: #666; font-family: monospace; }
    .duration-chip { background: #f5f5f5; color: #999; font-family: monospace; }

    .add-comment { margin-bottom: 24px; }
    .full-width { width: 100%; }
    .empty { color: #999; padding: 16px; text-align: center; }

    /* Re-run analysis bar */
    .reanalyze-bar { margin-bottom: 16px; }

    /* Floating AI help button */
    .ai-fab { position: fixed; bottom: 24px; right: 24px; z-index: 100; }
  `],
})
export class TicketDetailComponent implements OnInit {
  id = input.required<string>();

  private ticketService = inject(TicketService);
  private logSummaryService = inject(LogSummaryService);
  private aiUsageService = inject(AiUsageService);
  private destroyRef = inject(DestroyRef);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  ticket = signal<(Ticket & { client?: { name: string }; system?: { name: string } | null }) | null>(null);
  events = signal<TicketEvent[]>([]);
  logSummaries = signal<LogSummary[]>([]);
  ticketCost = signal<TicketCostResponse | null>(null);
  generatingLogs = signal(false);
  reanalyzing = signal(false);
  newComment = '';
  descExpanded = false;
  costDetailsExpanded = false;
  expandedEvents: Record<string, boolean> = {};

  // Logs tab state
  ticketLogs = signal<TicketAppLog[]>([]);
  ticketLogsTotal = signal(0);
  ticketLogsLoading = signal(false);
  ticketAiUsageLogs = signal<TicketAiUsageLog[]>([]);
  logsLevelFilter = signal('');
  logsSearchFilter = signal('');
  expandedLogs: Record<string, boolean> = {};

  // Timeline filter/sort
  timelineFilter = signal('');
  timelineSortAsc = signal(true); // true = oldest first (matches event order from API)

  filteredEvents = computed(() => {
    let evts = this.events();
    if (this.timelineFilter()) {
      evts = evts.filter(e => e.eventType === this.timelineFilter());
    }
    if (!this.timelineSortAsc()) {
      evts = [...evts].reverse();
    }
    return evts;
  });

  /** Extract a short email blurb from the first AI_ANALYSIS triage event. */
  emailBlurb = computed(() => {
    const evts = this.events();
    const triage = evts.find(e =>
      e.eventType === 'AI_ANALYSIS' &&
      (e.metadata as Record<string, unknown> | null)?.['phase'] === 'triage',
    );
    if (!triage) return null;
    const meta = triage.metadata as Record<string, unknown> | null;
    return (meta?.['summary'] as string) ?? null;
  });

  /** Build a process flow from events. */
  flowNodes = computed((): FlowNode[] => {
    const evts = this.events();
    if (evts.length === 0) return [];

    const nodes: FlowNode[] = [];
    const seen = new Set<string>();
    const inboundEmailCount = evts.filter(ev => ev.eventType === 'EMAIL_INBOUND').length;

    for (const e of evts) {
      const type = e.eventType;
      if (type === 'EMAIL_INBOUND' && !seen.has('EMAIL_INBOUND')) {
        seen.add('EMAIL_INBOUND');
        const children: FlowNode[] = [];

        const receipt = evts.find(ev =>
          ev.eventType === 'EMAIL_OUTBOUND' &&
          (ev.metadata as Record<string, unknown> | null)?.['type'] === 'receipt_confirmation',
        );
        if (receipt) {
          children.push({ label: 'RECEIPT SENT', icon: 'send', type: 'email' });
        }

        nodes.push({ label: 'EMAIL RECEIVED', icon: 'email', type: 'start', children: children.length > 0 ? children : undefined });
      }

      if (type === 'AI_ANALYSIS') {
        const phase = String((e.metadata as Record<string, unknown> | null)?.['phase'] ?? '');
        const analysisKey = 'AI_ANALYSIS_' + phase;
        if (!seen.has(analysisKey)) {
          seen.add(analysisKey);
          const label = phase === 'triage' ? 'TRIAGE' : phase === 'deep_analysis' ? 'AI ANALYSIS' : 'AI ANALYSIS';
          const children: FlowNode[] = [];

          if (phase === 'deep_analysis') {
            const findingsEmail = evts.find(ev =>
              ev.eventType === 'EMAIL_OUTBOUND' &&
              (ev.metadata as Record<string, unknown> | null)?.['type'] === 'analysis_findings',
            );
            if (findingsEmail) {
              children.push({ label: 'FINDINGS SENT', icon: 'send', type: 'email' });
            }
          }

          nodes.push({ label, icon: 'psychology', type: 'ai', children: children.length > 0 ? children : undefined });
        }
      }

      if (type === 'AI_RECOMMENDATION' && !seen.has('AI_RECOMMENDATION')) {
        seen.add('AI_RECOMMENDATION');
        const meta = e.metadata as Record<string, unknown> | null;
        const children: FlowNode[] = [];
        const actions = meta?.['actions'] as Array<{ action: string; applied: boolean }> | undefined;
        if (actions) {
          for (const a of actions) {
            if (a.applied && a.action === 'set_status') {
              children.push({ label: 'STATUS CHANGE', icon: 'swap_horiz', type: 'status' });
            }
          }
        }
        nodes.push({ label: 'RECOMMENDATION', icon: 'lightbulb', type: 'action', children: children.length > 0 ? children : undefined });
      }

      if (type === 'STATUS_CHANGE' && !seen.has('STATUS_CHANGE')) {
        seen.add('STATUS_CHANGE');
        const meta = e.metadata as Record<string, unknown> | null;
        const newStatus = meta?.['newStatus'] as string | undefined;
        nodes.push({ label: newStatus ? `STATUS: ${newStatus}` : 'STATUS CHANGE', icon: 'swap_horiz', type: 'status' });
      }

      if (type === 'EMAIL_INBOUND' && seen.has('EMAIL_INBOUND')) {
        if (inboundEmailCount > 1 && !seen.has('EMAIL_REPLY')) {
          seen.add('EMAIL_REPLY');
          nodes.push({ label: 'REPLY RECEIVED', icon: 'email', type: 'start' });
        }
      }
    }

    return nodes;
  });

  ngOnInit(): void {
    this.load();
    this.loadLogSummaries();
    this.loadTicketCost();
    this.loadTicketLogs();
    this.loadTicketAiUsage();
  }

  load(): void {
    this.ticketService.getTicket(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(t => {
      this.ticket.set(t);
      this.events.set(t.events ?? []);
    });
  }

  loadTicketCost(): void {
    this.aiUsageService
      .getTicketCost(this.id())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(cost => this.ticketCost.set(cost));
  }

  loadLogSummaries(): void {
    this.logSummaryService
      .getSummaries({ ticketId: this.id(), limit: 20 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(res => {
        this.logSummaries.set(res.summaries);
      });
  }

  loadTicketLogs(): void {
    this.ticketLogsLoading.set(true);
    const filters: Record<string, string | number> = { limit: 200 };
    const level = this.logsLevelFilter();
    const search = this.logsSearchFilter();
    if (level) filters['level'] = level;
    if (search) filters['search'] = search;

    this.ticketService
      .getTicketLogs(this.id(), filters as never)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.ticketLogs.set(res.logs);
          this.ticketLogsTotal.set(res.total);
          this.ticketLogsLoading.set(false);
        },
        error: () => this.ticketLogsLoading.set(false),
      });
  }

  loadTicketAiUsage(): void {
    this.ticketService
      .getTicketAiUsage(this.id(), { limit: 100 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(res => this.ticketAiUsageLogs.set(res.logs));
  }

  loadMoreLogs(): void {
    const current = this.ticketLogs();
    this.ticketLogsLoading.set(true);
    const filters: Record<string, string | number> = { limit: 200, offset: current.length };
    const level = this.logsLevelFilter();
    const search = this.logsSearchFilter();
    if (level) filters['level'] = level;
    if (search) filters['search'] = search;

    this.ticketService
      .getTicketLogs(this.id(), filters as never)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.ticketLogs.set([...current, ...res.logs]);
          this.ticketLogsTotal.set(res.total);
          this.ticketLogsLoading.set(false);
        },
        error: () => this.ticketLogsLoading.set(false),
      });
  }

  hasKeys(obj: Record<string, unknown>): boolean {
    return Object.keys(obj).length > 0;
  }

  generateLogSummary(): void {
    this.generatingLogs.set(true);
    this.logSummaryService
      .generateForTicket(this.id())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.generatingLogs.set(false);
          if (result.created > 0) {
            this.snackBar.open('Log summary generated', 'OK', { duration: 3000 });
            this.loadLogSummaries();
          } else {
            this.snackBar.open('No new logs to summarize', 'OK', { duration: 3000 });
          }
        },
        error: () => {
          this.generatingLogs.set(false);
          this.snackBar.open('Failed to generate log summary', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
        },
      });
  }

  updateStatus(status: string): void {
    this.ticketService.updateTicket(this.id(), { status } as never).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.snackBar.open('Status updated', 'OK', { duration: 3000 });
        this.load();
      },
      error: () => this.snackBar.open('Failed to update', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  updateField(field: 'priority' | 'category', value: string | null): void {
    this.ticketService.updateTicket(this.id(), { [field]: value } as never).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.snackBar.open(`${field.charAt(0).toUpperCase() + field.slice(1)} updated`, 'OK', { duration: 3000 });
        this.load();
      },
      error: () => this.snackBar.open(`Failed to update ${field}`, 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  reanalyze(): void {
    this.reanalyzing.set(true);
    this.ticketService.reanalyze(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.reanalyzing.set(false);
        this.snackBar.open('Analysis re-queued', 'OK', { duration: 3000 });
        this.load();
      },
      error: () => {
        this.reanalyzing.set(false);
        this.snackBar.open('Failed to re-queue analysis', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  openAiHelp(): void {
    const ticketId = this.id();
    const ticketSubject = this.ticket()?.subject ?? '';
    const data: AiHelpDialogData = {
      title: `Ask AI — ${ticketSubject}`,
      submitFn: (params) => firstValueFrom(this.ticketService.askAi(ticketId, params)),
    };
    const ref = this.dialog.open(AiHelpDialogComponent, {
      width: '600px',
      data,
    });
    ref.afterClosed().subscribe(() => {
      // Reload timeline to show any new AI_ANALYSIS events
      this.load();
      this.loadTicketCost();
    });
  }

  addComment(): void {
    this.ticketService.addEvent(this.id(), {
      eventType: 'COMMENT',
      content: this.newComment,
      actor: 'operator',
    }).subscribe({
      next: () => {
        this.newComment = '';
        this.load();
      },
      error: () => this.snackBar.open('Failed to add comment', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  toggleTimelineSort(): void {
    this.timelineSortAsc.update(v => !v);
  }

  eventIcon(type: string): string {
    const icons: Record<string, string> = {
      COMMENT: 'comment',
      STATUS_CHANGE: 'swap_horiz',
      PRIORITY_CHANGE: 'priority_high',
      CATEGORY_CHANGE: 'category',
      AI_ANALYSIS: 'psychology',
      AI_RECOMMENDATION: 'lightbulb',
      EMAIL_INBOUND: 'email',
      EMAIL_OUTBOUND: 'send',
      CODE_CHANGE: 'code',
      SYSTEM_NOTE: 'info',
    };
    return icons[type] ?? 'event';
  }

  /** Extract AI-relevant metadata from an event for display. */
  eventMeta(event: TicketEvent): {
    aiProvider?: string;
    aiModel?: string;
    phase?: string;
    taskType?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  } | null {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta) return null;
    const aiProvider = meta['aiProvider'] as string | undefined;
    const aiModel = meta['aiModel'] as string | undefined;
    if (!aiProvider && !aiModel) return null;
    const usage = meta['usage'] as { inputTokens?: number; outputTokens?: number } | undefined;
    return {
      aiProvider,
      aiModel,
      phase: meta['phase'] as string | undefined,
      taskType: meta['taskType'] as string | undefined,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      durationMs: meta['durationMs'] as number | undefined,
    };
  }

  /** Extract question from AI_ANALYSIS ai_help event metadata. */
  eventQuestion(event: TicketEvent): string | null {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta || meta['phase'] !== 'ai_help') return null;
    return (meta['question'] as string) ?? null;
  }

  formatAnalysisStatus(status: string | undefined): string {
    const labels: Record<string, string> = {
      PENDING: 'Pending',
      IN_PROGRESS: 'Analyzing...',
      COMPLETED: 'Analysis Complete',
      FAILED: 'Analysis Failed',
      SKIPPED: 'Skipped',
    };
    return labels[status ?? ''] ?? status ?? '-';
  }

  truncateDescription(desc: string): string {
    if (this.descExpanded || desc.length <= 300) return desc;
    return desc.slice(0, 300) + '...';
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
}
