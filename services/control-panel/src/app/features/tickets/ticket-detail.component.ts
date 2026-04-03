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
import { TicketService, Ticket, TicketEvent, type TicketAppLog, type TicketAiUsageLog, type PendingAction, type UnifiedLogEntry, type TicketCostSummary } from '../../core/services/ticket.service';
import { LogSummaryService, type LogSummary } from '../../core/services/log-summary.service';
import { AiUsageService, type TicketCostResponse } from '../../core/services/ai-usage.service';
import { AiHelpDialogComponent, type AiHelpDialogData } from '../../shared/components/ai-help-dialog.component';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { RelativeTimePipe } from '../../shared/pipes/relative-time.pipe';

interface FlowNode {
  label: string;
  icon: string;
  type: 'start' | 'action' | 'ai' | 'email' | 'status' | 'end';
  children?: FlowNode[];
}

@Component({
  standalone: true,
  imports: [CommonModule, RouterLink, DatePipe, JsonPipe, FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatProgressBarModule, MatTooltipModule, MatTabsModule, MarkdownPipe, RelativeTimePipe],
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
        @if (t.knowledgeDoc || editingKnowledgeDoc()) {
          <mat-tab label="Knowledge">
            <div class="tab-content knowledge-doc">
              @if (editingKnowledgeDoc()) {
                <textarea class="knowledge-editor" [(ngModel)]="knowledgeDocDraft" rows="20"></textarea>
                <div class="knowledge-actions">
                  <button mat-raised-button color="primary" (click)="saveKnowledgeDoc()">Save</button>
                  <button mat-stroked-button (click)="cancelEditKnowledgeDoc()">Cancel</button>
                </div>
              } @else {
                <div class="knowledge-actions">
                  <button mat-stroked-button (click)="startEditKnowledgeDoc()">
                    <mat-icon>edit</mat-icon> Edit
                  </button>
                  <button mat-stroked-button color="warn" (click)="clearKnowledgeDoc()">
                    <mat-icon>delete</mat-icon> Clear
                  </button>
                </div>
                <div [innerHTML]="t.knowledgeDoc | markdown"></div>
              }
            </div>
          </mat-tab>
        }
        <mat-tab>
          <ng-template mat-tab-label>
            Logs
            @if (unifiedLogsTotal() > 0) {
              <span class="tab-badge">{{ unifiedLogsTotal() }}</span>
            }
          </ng-template>
          <div class="tab-content">
            <!-- Cost summary card -->
            @if (costSummary(); as cs) {
              @if (cs.callCount > 0) {
                <div class="logs-cost-summary">
                  <div class="cost-summary-row">
                    <div class="cost-summary-item">
                      <span class="cost-summary-label">Total Cost</span>
                      <span class="cost-summary-value">\${{ cs.totalCostUsd | number:'1.4-4' }}</span>
                    </div>
                    <div class="cost-summary-item">
                      <span class="cost-summary-label">AI Calls</span>
                      <span class="cost-summary-value">{{ cs.callCount }}</span>
                    </div>
                    <div class="cost-summary-item">
                      <span class="cost-summary-label">Tool Calls</span>
                      <span class="cost-summary-value">{{ cs.toolCallCount }}</span>
                    </div>
                    <div class="cost-summary-item">
                      <span class="cost-summary-label">Total Duration</span>
                      <span class="cost-summary-value">{{ formatDuration(cs.totalDurationMs) }}</span>
                    </div>
                  </div>
                  @if (cs.breakdown.length > 0) {
                    <div class="cost-breakdown-inline">
                      @for (b of cs.breakdown; track b.provider + ':' + b.model) {
                        <span class="breakdown-chip">
                          <span class="meta-chip provider-chip provider-{{ b.provider.toLowerCase() }}">{{ b.provider }}</span>
                          <code class="model-name-sm">{{ b.model }}</code>:
                          \${{ b.totalCostUsd | number:'1.4-4' }} ({{ b.callCount }} calls)
                        </span>
                      }
                    </div>
                  }
                </div>
              }
            }

            <!-- Filter bar -->
            <div class="logs-filter-bar">
              <mat-form-field class="logs-filter-field">
                <mat-label>Type</mat-label>
                <mat-select [ngModel]="unifiedTypeFilter()" (ngModelChange)="unifiedTypeFilter.set($event); loadUnifiedLogs()">
                  <mat-option value="">All</mat-option>
                  <mat-option value="ai">AI Calls</mat-option>
                  <mat-option value="tool">Tool Calls</mat-option>
                  <mat-option value="step">Steps</mat-option>
                  <mat-option value="error">Errors</mat-option>
                  <mat-option value="log">Logs</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field class="logs-filter-field">
                <mat-label>Level</mat-label>
                <mat-select [ngModel]="logsLevelFilter()" (ngModelChange)="logsLevelFilter.set($event); loadUnifiedLogs()">
                  <mat-option value="">All</mat-option>
                  <mat-option value="ERROR">Error</mat-option>
                  <mat-option value="WARN">Warn</mat-option>
                  <mat-option value="INFO">Info</mat-option>
                  <mat-option value="DEBUG">Debug</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field class="logs-filter-field">
                <mat-label>Search</mat-label>
                <input matInput [ngModel]="logsSearchFilter()" (ngModelChange)="logsSearchFilter.set($event)" (keyup.enter)="loadUnifiedLogs()">
              </mat-form-field>
              <button mat-icon-button matTooltip="Search" (click)="loadUnifiedLogs()">
                <mat-icon>search</mat-icon>
              </button>
              <button mat-icon-button matTooltip="Refresh" (click)="loadUnifiedLogs()">
                <mat-icon>refresh</mat-icon>
              </button>
            </div>

            @if (unifiedLogsLoading()) {
              <mat-progress-bar mode="indeterminate"></mat-progress-bar>
            }

            <!-- Unified log stream -->
            <div class="logs-list">
              @for (entry of unifiedLogs(); track entry.id; let idx = $index) {
                <!-- Iteration group header -->
                @if (isIterationHeader(entry)) {
                  <div class="iteration-group-header">
                    <mat-icon class="iteration-icon">loop</mat-icon>
                    <span class="iteration-label">{{ extractIterationLabel(entry) }}</span>
                    <span class="log-seq">#{{ idx + 1 }}</span>
                    <span class="log-time" [matTooltip]="entry.timestamp">{{ formatTime(entry.timestamp) }}</span>
                  </div>
                } @else {
                <div class="log-entry" [ngClass]="'unified-type-' + entry.type" [class.iteration-grouped]="isWithinIteration(entry)">
                  <div class="log-entry-header">
                    <span class="log-seq">#{{ idx + 1 }}</span>
                    <span class="log-time" [matTooltip]="entry.timestamp">{{ formatTime(entry.timestamp) }}</span>
                    <span class="unified-type-badge" [ngClass]="'ubadge-' + entry.type">{{ entry.type | uppercase }}</span>

                    <!-- AI entry display -->
                    @if (entry.type === 'ai') {
                      <span class="meta-chip provider-chip provider-{{ (entry.provider ?? '').toLowerCase() }}">{{ entry.provider }}</span>
                      <code class="meta-chip model-chip">{{ entry.model }}</code>
                      <span class="meta-chip task-chip">{{ entry.taskType }}</span>
                      <span class="meta-chip token-chip">{{ entry.inputTokens | number }}in / {{ entry.outputTokens | number }}out</span>
                      @if (entry.durationMs != null) {
                        <span class="meta-chip duration-chip">{{ entry.durationMs | number }}ms</span>
                      }
                      @if (entry.costUsd != null) {
                        <span class="ai-usage-cost">\${{ entry.costUsd | number:'1.4-4' }}</span>
                      }
                      @if (!expandedLogs[entry.id] && promptFirstLine(entry)) {
                        <span class="prompt-preview">{{ promptFirstLine(entry) }}</span>
                      }
                    }

                    <!-- Log/Tool/Step/Error entry display -->
                    @if (entry.type !== 'ai') {
                      @if (entry.level) {
                        <span class="log-level-badge log-badge-{{ entry.level.toLowerCase() }}">{{ entry.level }}</span>
                      }
                      @if (entry.service) {
                        <span class="log-service">{{ entry.service }}</span>
                      }
                      <span class="log-message">{{ entry.message }}</span>
                    }
                  </div>

                  <!-- Expandable AI detail -->
                  @if (entry.type === 'ai') {
                    <button mat-button class="log-expand-btn" (click)="expandedLogs[entry.id] = !expandedLogs[entry.id]">
                      {{ expandedLogs[entry.id] ? 'Hide details' : 'Show details' }}
                      <mat-icon>{{ expandedLogs[entry.id] ? 'expand_less' : 'expand_more' }}</mat-icon>
                    </button>
                    @if (expandedLogs[entry.id]) {
                      <div class="ai-detail-sections">
                        @if (entry.promptKey) {
                          <div class="ai-detail-label">Prompt Key: <code>{{ entry.promptKey }}</code></div>
                        }
                        @if (entry.archive?.fullPrompt || entry.promptText) {
                          <div class="ai-detail-block">
                            <div class="ai-detail-label">Prompt</div>
                            <pre class="log-metadata">{{ entry.archive?.fullPrompt ?? entry.promptText }}</pre>
                          </div>
                        }
                        @if (entry.archive?.systemPrompt || entry.systemPrompt) {
                          <div class="ai-detail-block">
                            <button mat-button class="log-expand-btn sys-prompt-toggle" (click)="expandedSystemPrompts[entry.id] = !expandedSystemPrompts[entry.id]">
                              System Prompt
                              <mat-icon>{{ expandedSystemPrompts[entry.id] ? 'expand_less' : 'expand_more' }}</mat-icon>
                            </button>
                            @if (expandedSystemPrompts[entry.id]) {
                              <pre class="log-metadata">{{ entry.archive?.systemPrompt ?? entry.systemPrompt }}</pre>
                            }
                          </div>
                        }
                        @if (entry.archive?.fullResponse || entry.responseText) {
                          <div class="ai-detail-block">
                            <div class="ai-detail-label">Response</div>
                            <pre class="log-metadata">{{ entry.archive?.fullResponse ?? entry.responseText }}</pre>
                          </div>
                        }
                        @if (entry.conversationMetadata) {
                          <div class="ai-detail-block">
                            <div class="ai-detail-label">Conversation Metadata</div>
                            <pre class="log-metadata">{{ entry.conversationMetadata | json }}</pre>
                          </div>
                        }
                        @if (entry.archive?.messageCount != null) {
                          <div class="ai-detail-label">Messages: {{ entry.archive?.messageCount }} &middot; Context tokens: {{ entry.archive?.totalContextTokens | number }}</div>
                        }
                      </div>
                    }
                  }

                  <!-- Expandable metadata for log entries -->
                  @if (entry.type !== 'ai') {
                    @if (entry.context && hasKeys(entry.context)) {
                      <button mat-button class="log-expand-btn" (click)="expandedLogs[entry.id] = !expandedLogs[entry.id]">
                        {{ expandedLogs[entry.id] ? 'Hide metadata' : 'Show metadata' }}
                        <mat-icon>{{ expandedLogs[entry.id] ? 'expand_less' : 'expand_more' }}</mat-icon>
                      </button>
                      @if (expandedLogs[entry.id]) {
                        <pre class="log-metadata">{{ entry.context | json }}</pre>
                      }
                    }
                    @if (entry.error) {
                      <div class="log-error-detail">{{ entry.error }}</div>
                    }
                  }
                </div>
                }
              } @empty {
                @if (!unifiedLogsLoading()) {
                  <p class="empty">No logs found for this ticket.</p>
                }
              }
            </div>

            <!-- Pagination -->
            @if (unifiedLogsTotal() > unifiedLogs().length) {
              <div class="logs-pagination">
                <span class="logs-showing">Showing {{ unifiedLogs().length }} of {{ unifiedLogsTotal() }}</span>
                <button mat-stroked-button (click)="loadMoreUnifiedLogs()">Load more</button>
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
          <mat-card class="event-card" [ngClass]="'event-type-' + event.eventType.toLowerCase()">
            <mat-card-content>
              <div class="event-header">
                <span class="event-type-badge" [ngClass]="'badge-' + event.eventType.toLowerCase()">
                  <mat-icon>{{ eventIcon(event.eventType) }}</mat-icon>
                  <span>{{ formatEventType(event.eventType) }}</span>
                </span>
                @if (isAiTriggered(event)) {
                  <span class="ai-triggered-badge">AI Recommendation</span>
                }
                <span class="event-actor">{{ event.actor }}</span>
                @if (isAgenticAnalysis(event)) {
                  @if (agenticMeta(event); as am) {
                    @if (am.totalCostUsd != null && am.totalCostUsd > 0) {
                      <span class="cost-badge">\${{ am.totalCostUsd | number:'1.4-4' }}</span>
                    }
                  }
                }
                <span class="event-date" [matTooltip]="event.createdAt | date:'medium'">{{ event.createdAt | relativeTime }}</span>
              </div>

              <!-- Condensed Agentic Analysis card -->
              @if (isAgenticAnalysis(event)) {
                @if (agenticMeta(event); as am) {
                  <div class="agentic-summary">
                    <div class="agentic-stats">
                      <span class="meta-chip task-chip">{{ am.taskType }}</span>
                      <span class="meta-chip token-chip">{{ am.toolCallCount }} tool calls</span>
                      <span class="meta-chip phase-chip">{{ am.iterationsRun }} iterations</span>
                      @if (am.sufficiencyStatus) {
                        <span class="meta-chip" [ngClass]="'sufficiency-' + am.sufficiencyStatus.toLowerCase()">{{ am.sufficiencyStatus }}</span>
                      }
                      @if (am.sufficiencyConfidence) {
                        <span class="meta-chip duration-chip">confidence: {{ am.sufficiencyConfidence }}</span>
                      }
                    </div>

                    <!-- Collapsible Tool Calls -->
                    @if (am.toolCalls.length > 0) {
                      <button mat-button class="show-more-btn" (click)="expandedSections[event.id + ':tools'] = !expandedSections[event.id + ':tools']">
                        <mat-icon>{{ expandedSections[event.id + ':tools'] ? 'expand_less' : 'expand_more' }}</mat-icon>
                        Tool Calls ({{ am.toolCalls.length }})
                      </button>
                      @if (expandedSections[event.id + ':tools']) {
                        <div class="tool-calls-list">
                          @for (tc of am.toolCalls; track $index) {
                            <div class="tool-call-row">
                              <span class="tool-name">{{ tc.tool }}</span>
                              @if (tc.system) { <span class="meta-chip provider-chip provider-local">{{ tc.system }}</span> }
                              @if (tc.durationMs != null) { <span class="meta-chip duration-chip">{{ tc.durationMs }}ms</span> }
                              @if (tc.output) {
                                <button mat-button class="show-more-btn" (click)="expandedSections[event.id + ':tc:' + $index] = !expandedSections[event.id + ':tc:' + $index]">
                                  {{ expandedSections[event.id + ':tc:' + $index] ? 'Hide' : 'Result' }}
                                </button>
                              }
                              @if (expandedSections[event.id + ':tc:' + $index] && tc.output) {
                                <pre class="tool-result">{{ tc.output }}</pre>
                              }
                            </div>
                          }
                        </div>
                      }
                    }

                    <!-- Collapsible Sufficiency details -->
                    @if (am.sufficiencyReason) {
                      <button mat-button class="show-more-btn" (click)="expandedSections[event.id + ':sufficiency'] = !expandedSections[event.id + ':sufficiency']">
                        <mat-icon>{{ expandedSections[event.id + ':sufficiency'] ? 'expand_less' : 'expand_more' }}</mat-icon>
                        Sufficiency
                      </button>
                      @if (expandedSections[event.id + ':sufficiency']) {
                        <div class="sufficiency-detail">
                          <p><strong>Status:</strong> {{ am.sufficiencyStatus }} &middot; <strong>Confidence:</strong> {{ am.sufficiencyConfidence }}</p>
                          <p>{{ am.sufficiencyReason }}</p>
                          @if (am.sufficiencyQuestions && am.sufficiencyQuestions.length > 0) {
                            <p><strong>Questions:</strong></p>
                            <ul>@for (q of am.sufficiencyQuestions; track $index) { <li>{{ q }}</li> }</ul>
                          }
                        </div>
                      }
                    }
                  </div>

                  <!-- Collapsible Analysis content -->
                  @if (event.content) {
                    <button mat-button class="show-more-btn" (click)="expandedSections[event.id + ':analysis'] = !expandedSections[event.id + ':analysis']">
                      <mat-icon>{{ expandedSections[event.id + ':analysis'] ? 'expand_less' : 'expand_more' }}</mat-icon>
                      Analysis
                    </button>
                    @if (expandedSections[event.id + ':analysis']) {
                      <div class="event-content markdown-content">
                        <div [innerHTML]="event.content | markdown"></div>
                      </div>
                    }
                  }
                }
              }

              <!-- SYSTEM_NOTE with JSON probe data detection -->
              @else if (event.eventType === 'SYSTEM_NOTE' && isJsonContent(event.content)) {
                <button mat-button class="show-more-btn" (click)="expandedEvents[event.id] = !expandedEvents[event.id]">
                  <mat-icon>{{ expandedEvents[event.id] ? 'expand_less' : 'expand_more' }}</mat-icon>
                  Probe Data
                </button>
                @if (expandedEvents[event.id]) {
                  <pre class="probe-data">{{ formatJson(event.content!) }}</pre>
                }
              }

              <!-- AI_RECOMMENDATION — render as action list -->
              @else if (event.eventType === 'AI_RECOMMENDATION') {
                @if (eventMeta(event); as meta) {
                  @if (meta.aiProvider || meta.aiModel) {
                    <div class="event-ai-meta">
                      @if (meta.aiProvider) { <span class="meta-chip provider-chip provider-{{ meta.aiProvider.toLowerCase() }}">{{ meta.aiProvider }}</span> }
                      @if (meta.aiModel) { <code class="meta-chip model-chip">{{ meta.aiModel }}</code> }
                    </div>
                  }
                }
                @if (recommendationActions(event); as actions) {
                  <div class="recommendation-actions">
                    @for (action of actions; track $index) {
                      <div class="recommendation-row" [class.action-applied]="action.applied">
                        <mat-icon class="action-status-icon">{{ action.applied ? 'check_circle' : 'radio_button_unchecked' }}</mat-icon>
                        <span class="action-label">{{ action.action }}</span>
                        @if (action.detail) { <span class="action-detail">{{ action.detail }}</span> }
                      </div>
                    }
                  </div>
                }
              }
              @if (event.content) {
                @if (event.eventType === 'SYSTEM_NOTE' && isJsonContent(event.content)) {
                  <!-- Probe data / JSON SYSTEM_NOTE — collapsible formatted code block -->
                  <div class="probe-data-section">
                    <button mat-button class="show-more-btn" (click)="expandedEvents[event.id] = !expandedEvents[event.id]">
                      <mat-icon>{{ expandedEvents[event.id] ? 'expand_less' : 'expand_more' }}</mat-icon>
                      {{ expandedEvents[event.id] ? 'Hide Probe Data' : 'Show Probe Data' }}
                    </button>
                    @if (expandedEvents[event.id]) {
                      <pre class="probe-data-code"><code>{{ formatJson(event.content) }}</code></pre>
                    }
                  </div>
                } @else if (event.eventType === 'AI_RECOMMENDATION' && hasActionsMeta(event)) {
                  <!-- AI Recommendation with actions — human-readable list -->
                  <div class="recommendation-actions">
                    @for (act of getEventActions(event); track $index) {
                      <div class="rec-action-row">
                        <mat-icon class="rec-icon">{{ recActionIcon(act.action) }}</mat-icon>
                        <div class="rec-action-detail">
                          <span class="rec-action-type">{{ formatRecActionType(act.action) }}</span>
                          @if (act.value) {
                            <span class="rec-action-value">{{ act.value }}</span>
                          }
                          <span class="rec-action-reason">{{ act.reason }}</span>
                        </div>
                        <span class="rec-status-badge" [class]="'rec-badge-' + getActionOutcome(act)">
                          {{ getActionOutcomeLabel(act) }}
                        </span>
                        @if (getActionOutcome(act) === 'pending_approval') {
                          <button mat-stroked-button color="primary" class="rec-approve-btn" (click)="approvePendingAction(act.pendingActionId)">Approve</button>
                          <button mat-stroked-button class="rec-dismiss-btn" (click)="dismissPendingAction(act.pendingActionId)">Dismiss</button>
                        }
                      </div>
                    }
                  </div>
                  @if (event.content && event.content.length > 0) {
                    <div class="event-content markdown-content" [class.collapsed]="!expandedEvents[event.id + '-raw'] && event.content.length > 300">
                      <div [innerHTML]="event.content | markdown"></div>
                    </div>
                    @if (event.content.length > 300) {
                      <button mat-button class="show-more-btn" (click)="expandedEvents[event.id + '-raw'] = !expandedEvents[event.id + '-raw']">
                        {{ expandedEvents[event.id + '-raw'] ? 'Hide details' : 'Show details' }}
                      </button>
                    }
                  }
                } @else if (isMarkdownEvent(event.eventType)) {
                  <div class="event-content markdown-content" [class.collapsed]="!expandedEvents[event.id] && event.content.length > 300">
                    <div [innerHTML]="event.content | markdown"></div>
                  </div>
                  @if (event.content.length > 300) {
                    <button mat-button class="show-more-btn" (click)="expandedEvents[event.id] = !expandedEvents[event.id]">
                      {{ expandedEvents[event.id] ? 'Show less' : 'Show more' }}
                    </button>
                  }
                }
              }

              <!-- Default rendering for all other event types -->
              @else {
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
                  @if (isMarkdownEvent(event.eventType)) {
                    <div class="event-content markdown-content" [class.collapsed]="!expandedEvents[event.id] && event.content.length > 300">
                      <div [innerHTML]="event.content | markdown"></div>
                    </div>
                  } @else {
                    <p class="event-content" [class.collapsed]="!expandedEvents[event.id] && event.content.length > 300">
                      {{ expandedEvents[event.id] ? event.content : event.content.slice(0, 300) }}
                      @if (event.content.length > 300 && !expandedEvents[event.id]) {
                        <span class="ellipsis">...</span>
                      }
                    </p>
                  }
                  @if (event.content.length > 300) {
                    <button mat-button class="show-more-btn" (click)="expandedEvents[event.id] = !expandedEvents[event.id]">
                      {{ expandedEvents[event.id] ? 'Show less' : 'Show more' }}
                    </button>
                  }
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
    .knowledge-doc { font-size: 14px; line-height: 1.6; }
    .knowledge-doc h3 { margin-top: 16px; margin-bottom: 8px; font-size: 16px; color: #333; border-bottom: 1px solid #e0e0e0; padding-bottom: 4px; }
    .knowledge-doc h4 { margin-top: 12px; margin-bottom: 6px; font-size: 14px; color: #555; }
    .knowledge-doc pre { background: #f5f5f5; padding: 8px 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; }
    .knowledge-doc code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
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
    .event-type-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #f5f5f5; color: #555; }
    .event-type-badge mat-icon { font-size: 15px; width: 15px; height: 15px; }
    .badge-ai_analysis { background: #ede7f6; color: #5e35b1; }
    .badge-ai_recommendation { background: #fff8e1; color: #f57f17; }
    .badge-email_inbound { background: #e8f5e9; color: #2e7d32; }
    .badge-email_outbound { background: #e3f2fd; color: #1565c0; }
    .badge-status_change { background: #fff3e0; color: #e65100; }
    .badge-code_change { background: #fce4ec; color: #c62828; }
    .event-actor { color: #666; font-size: 13px; }
    .event-date { color: #999; font-size: 13px; margin-left: auto; cursor: default; }
    .event-question { display: flex; align-items: flex-start; gap: 4px; margin-top: 6px; padding: 6px 10px; background: #e3f2fd; border-radius: 6px; font-size: 13px; color: #1565c0; }
    .question-icon { font-size: 16px; width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; }
    .event-content { margin-top: 8px; white-space: pre-wrap; line-height: 1.5; }
    .event-content.collapsed { max-height: 100px; overflow: hidden; }
    .ellipsis { color: #999; }
    .event-type-ai_analysis { border-left: 3px solid #7c4dff; }
    .event-type-ai_recommendation { border-left: 3px solid #ffab00; }
    .event-type-system_note { border-left: 3px solid #bdbdbd; }
    .event-type-email_inbound, .event-type-email_outbound { border-left: 3px solid #4caf50; }
    .event-type-code_change { border-left: 3px solid #e91e63; }
    /* Probe data (JSON SYSTEM_NOTE) */
    .probe-data-section { margin-top: 8px; }
    .probe-data-code { background: #263238; color: #eeffff; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
    /* AI Recommendation action list */
    .recommendation-actions { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    .rec-action-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #fafafa; border-radius: 6px; border: 1px solid #eee; }
    .rec-icon { font-size: 18px; width: 18px; height: 18px; color: #666; flex-shrink: 0; }
    .rec-action-detail { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
    .rec-action-type { font-weight: 600; font-size: 13px; }
    .rec-action-value { font-family: monospace; font-size: 12px; background: #e8eaf6; padding: 1px 6px; border-radius: 3px; color: #283593; }
    .rec-action-reason { font-size: 12px; color: #666; }
    .rec-status-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
    .rec-badge-auto_executed { background: #e8f5e9; color: #2e7d32; }
    .rec-badge-pending_approval { background: #fff3e0; color: #e65100; }
    .rec-badge-skipped { background: #f5f5f5; color: #999; }
    .rec-badge-dismissed { background: #fce4ec; color: #c62828; }
    .rec-badge-approved { background: #e8f5e9; color: #2e7d32; }
    .rec-approve-btn, .rec-dismiss-btn { font-size: 11px; min-height: 28px; line-height: 28px; padding: 0 10px; }
    .ai-triggered-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: #fff8e1; color: #f57f17; white-space: nowrap; }
    .markdown-content { white-space: normal; }
    .markdown-content h1, .markdown-content h2, .markdown-content h3 { margin: 10px 0 4px; }
    .markdown-content h1 { font-size: 1.25em; }
    .markdown-content h2 { font-size: 1.1em; }
    .markdown-content p { margin: 4px 0; }
    .markdown-content ul, .markdown-content ol { margin: 4px 0; padding-left: 24px; }
    .markdown-content code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    .markdown-content pre { background: #263238; color: #eeffff; padding: 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0; }
    .markdown-content pre code { background: transparent; color: inherit; padding: 0; }
    .markdown-content blockquote { border-left: 3px solid #ddd; margin: 6px 0; padding: 2px 12px; color: #666; }
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

    /* Agentic analysis card */
    .agentic-summary { margin-top: 8px; }
    .agentic-stats { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
    .sufficiency-sufficient { background: #e8f5e9; color: #2e7d32; }
    .sufficiency-needs_user_input { background: #fff3e0; color: #e65100; }
    .sufficiency-insufficient { background: #ffebee; color: #c62828; }
    .tool-calls-list { padding: 4px 0 4px 12px; border-left: 2px solid #e0e0e0; margin: 4px 0; }
    .tool-call-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 0; flex-wrap: wrap; }
    .tool-name { font-weight: 600; font-family: monospace; color: #333; font-size: 12px; }
    .tool-result { font-size: 11px; background: #f5f5f5; padding: 6px; border-radius: 4px; margin: 2px 0; overflow-x: auto; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; width: 100%; }
    .sufficiency-detail { font-size: 13px; padding: 8px 12px; background: #fafafa; border-radius: 4px; margin: 4px 0; }
    .sufficiency-detail p { margin: 2px 0; }
    .sufficiency-detail ul { margin: 4px 0; padding-left: 20px; }
    .cost-badge { font-size: 11px; font-weight: 600; font-family: monospace; color: #2e7d32; background: #e8f5e9; padding: 2px 8px; border-radius: 4px; }

    /* Probe data */
    .probe-data { font-size: 11px; background: #263238; color: #eeffff; padding: 10px; border-radius: 6px; overflow-x: auto; margin: 6px 0; max-height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }

    /* Recommendation actions */
    .recommendation-actions { margin: 8px 0; }
    .recommendation-row { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 3px 0; }
    .recommendation-row.action-applied .action-status-icon { color: #2e7d32; }
    .action-status-icon { font-size: 16px; width: 16px; height: 16px; color: #999; }
    .action-label { font-weight: 500; }
    .action-detail { color: #666; font-size: 12px; }

    /* Unified logs */
    .unified-type-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
    .ubadge-log { background: #e3f2fd; color: #1565c0; }
    .ubadge-ai { background: #f3e5f5; color: #6a1b9a; }
    .ubadge-tool { background: #e8f5e9; color: #2e7d32; }
    .ubadge-step { background: #fff3e0; color: #e65100; }
    .ubadge-error { background: #ffebee; color: #c62828; }
    .log-seq { font-size: 10px; color: #bbb; font-family: monospace; min-width: 32px; flex-shrink: 0; }
    .iteration-group-header { display: flex; align-items: center; gap: 6px; padding: 8px 10px 4px; margin-top: 8px; border-top: 2px solid #e0e0e0; }
    .iteration-group-header:first-child { margin-top: 0; border-top: none; }
    .iteration-icon { font-size: 16px; width: 16px; height: 16px; color: #7c4dff; }
    .iteration-label { font-size: 12px; font-weight: 600; color: #5e35b1; }
    .iteration-grouped { border-left-width: 3px; margin-left: 8px; }
    .unified-type-error { border-left-color: #c62828; background: #fff8f8; }
    .unified-type-ai { border-left-color: #7c4dff; background: #faf8ff; }
    .unified-type-tool { border-left-color: #2e7d32; background: #f8fff8; }
    .unified-type-step { border-left-color: #e65100; background: #fffaf5; }

    /* AI detail sections in unified logs */
    .ai-detail-sections { padding: 8px 0 4px; }
    .ai-detail-label { font-size: 11px; font-weight: 600; color: #666; margin: 4px 0 2px; }
    .ai-detail-label code { font-weight: 400; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
    .ai-detail-block { margin-bottom: 8px; }
    .prompt-preview { display: block; font-size: 11px; color: #888; font-family: monospace; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 600px; }
    .sys-prompt-toggle { min-height: 24px; font-size: 11px; font-weight: 600; color: #666; padding: 0 4px; text-transform: uppercase; letter-spacing: 0.3px; }

    /* Logs cost summary */
    .logs-cost-summary { background: #f8faf8; border: 1px solid #e0e8e0; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
    .cost-summary-row { display: flex; gap: 24px; flex-wrap: wrap; }
    .cost-summary-item { display: flex; flex-direction: column; }
    .cost-summary-label { font-size: 10px; text-transform: uppercase; color: #666; letter-spacing: 0.5px; }
    .cost-summary-value { font-size: 16px; font-weight: 600; font-family: monospace; color: #222; }
    .cost-breakdown-inline { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: #555; }
    .breakdown-chip { display: flex; align-items: center; gap: 4px; }
    .model-name-sm { font-size: 10px; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }

    /* Knowledge doc editing */
    .knowledge-editor { width: 100%; font-family: monospace; font-size: 13px; padding: 12px; border: 1px solid #ccc; border-radius: 6px; resize: vertical; box-sizing: border-box; }
    .knowledge-actions { display: flex; gap: 8px; margin-bottom: 12px; }

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

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL_MS = 4_000;
  private readonly TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'PENDING']);
  private knownEventIds = new Set<string>();
  private lastUnifiedLogAt: string | null = null;

  ticket = signal<(Ticket & { client?: { name: string }; system?: { name: string } | null }) | null>(null);
  events = signal<TicketEvent[]>([]);
  logSummaries = signal<LogSummary[]>([]);
  ticketCost = signal<TicketCostResponse | null>(null);
  generatingLogs = signal(false);
  reanalyzing = signal(false);
  editingKnowledgeDoc = signal(false);
  knowledgeDocDraft = '';
  newComment = '';
  descExpanded = false;
  costDetailsExpanded = false;
  expandedEvents: Record<string, boolean> = {};
  expandedSections: Record<string, boolean> = {};

  // Unified logs tab state
  unifiedLogs = signal<UnifiedLogEntry[]>([]);
  unifiedLogsTotal = signal(0);
  unifiedLogsLoading = signal(false);
  unifiedTypeFilter = signal('');
  logsLevelFilter = signal('');
  logsSearchFilter = signal('');
  expandedLogs: Record<string, boolean> = {};
  expandedSystemPrompts: Record<string, boolean> = {};
  costSummary = signal<TicketCostSummary | null>(null);

  // Legacy — still used by loadTicketAiUsage for the existing AI Cost card
  ticketLogs = signal<TicketAppLog[]>([]);
  ticketLogsTotal = signal(0);
  ticketLogsLoading = signal(false);
  ticketAiUsageLogs = signal<TicketAiUsageLog[]>([]);

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
    this.loadUnifiedLogs();
    this.loadCostSummary();
    this.loadTicketAiUsage();
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  load(): void {
    this.ticketService.getTicket(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(t => {
      this.ticket.set(t);
      const incoming = t.events ?? [];
      if (this.knownEventIds.size === 0) {
        this.events.set(incoming);
        for (const e of incoming) this.knownEventIds.add(e.id);
      } else {
        const newEvents = incoming.filter(e => !this.knownEventIds.has(e.id));
        if (newEvents.length > 0) {
          this.events.update(current => [...current, ...newEvents]);
          for (const e of newEvents) this.knownEventIds.add(e.id);
        }
      }
      this.managePoll(t.analysisStatus);
    });
  }

  private managePoll(analysisStatus: string | null | undefined): void {
    if (analysisStatus === 'IN_PROGRESS') {
      if (!this.pollHandle) {
        this.pollHandle = setInterval(() => {
          this.load();
          this.pollUnifiedLogs();
          this.loadTicketCost();
          this.loadCostSummary();
        }, this.POLL_INTERVAL_MS);
      }
    } else {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
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

  // Legacy loadTicketLogs — replaced by loadUnifiedLogs
  loadTicketLogs(): void { /* no-op */ }

  loadTicketAiUsage(): void {
    this.ticketService
      .getTicketAiUsage(this.id(), { limit: 100 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.ticketAiUsageLogs.set(res.logs),
        error: () => {},
      });
  }

  loadUnifiedLogs(): void {
    this.unifiedLogsLoading.set(true);
    const filters: Record<string, string | number> = { limit: 200 };
    const type = this.unifiedTypeFilter();
    const level = this.logsLevelFilter();
    const search = this.logsSearchFilter();
    if (type) filters['type'] = type;
    if (level) filters['level'] = level;
    if (search) filters['search'] = search;

    this.ticketService
      .getUnifiedLogs(this.id(), filters as never)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.unifiedLogs.set(res.entries);
          this.unifiedLogsTotal.set(res.total);
          this.unifiedLogsLoading.set(false);
          if (res.entries.length > 0) {
            this.lastUnifiedLogAt = res.entries[res.entries.length - 1].timestamp;
          }
        },
        error: () => this.unifiedLogsLoading.set(false),
      });
  }

  private pollUnifiedLogs(): void {
    if (!this.lastUnifiedLogAt) return;
    const filters: Record<string, string | number> = { limit: 200, createdAfter: this.lastUnifiedLogAt };
    const type = this.unifiedTypeFilter();
    const level = this.logsLevelFilter();
    const search = this.logsSearchFilter();
    if (type) filters['type'] = type;
    if (level) filters['level'] = level;
    if (search) filters['search'] = search;

    this.ticketService
      .getUnifiedLogs(this.id(), filters as never)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (res.entries.length > 0) {
            this.unifiedLogs.update(current => [...current, ...res.entries]);
            this.unifiedLogsTotal.update(t => t + res.entries.length);
            this.lastUnifiedLogAt = res.entries[res.entries.length - 1].timestamp;
          }
        },
        error: () => {},
      });
  }

  loadMoreUnifiedLogs(): void {
    if (this.unifiedLogsLoading()) return;
    const current = this.unifiedLogs();
    this.unifiedLogsLoading.set(true);
    const filters: Record<string, string | number> = { limit: 200, offset: current.length };
    const type = this.unifiedTypeFilter();
    const level = this.logsLevelFilter();
    const search = this.logsSearchFilter();
    if (type) filters['type'] = type;
    if (level) filters['level'] = level;
    if (search) filters['search'] = search;

    this.ticketService
      .getUnifiedLogs(this.id(), filters as never)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.unifiedLogs.set([...current, ...res.entries]);
          this.unifiedLogsTotal.set(res.total);
          this.unifiedLogsLoading.set(false);
        },
        error: () => this.unifiedLogsLoading.set(false),
      });
  }

  loadCostSummary(): void {
    this.ticketService
      .getCostSummary(this.id())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cs) => this.costSummary.set(cs),
        error: () => {},
      });
  }

  loadMoreLogs(): void {
    // Legacy — kept for backward compatibility but loadMoreUnifiedLogs is primary
  }

  hasKeys(obj: Record<string, unknown>): boolean {
    return Object.keys(obj).length > 0;
  }

  promptFirstLine(entry: UnifiedLogEntry): string {
    const text = entry.archive?.fullPrompt ?? entry.promptText ?? '';
    const line = text.split('\n').find(l => l.trim().length > 0) ?? '';
    return line.length > 120 ? line.slice(0, 120) + '…' : line;
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

  startEditKnowledgeDoc(): void {
    this.knowledgeDocDraft = this.ticket()?.knowledgeDoc ?? '';
    this.editingKnowledgeDoc.set(true);
  }

  cancelEditKnowledgeDoc(): void {
    this.editingKnowledgeDoc.set(false);
    this.knowledgeDocDraft = '';
  }

  saveKnowledgeDoc(): void {
    const doc = this.knowledgeDocDraft.trim() || null;
    this.ticketService.updateKnowledgeDoc(this.id(), doc).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.editingKnowledgeDoc.set(false);
        this.knowledgeDocDraft = '';
        this.snackBar.open('Knowledge doc updated', 'OK', { duration: 3000 });
        this.load();
      },
      error: () => this.snackBar.open('Failed to update knowledge doc', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  clearKnowledgeDoc(): void {
    if (!confirm('This will remove all investigation history. Continue?')) return;
    this.ticketService.updateKnowledgeDoc(this.id(), null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.snackBar.open('Knowledge doc cleared', 'OK', { duration: 3000 });
        this.load();
      },
      error: () => this.snackBar.open('Failed to clear knowledge doc', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
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

  isMarkdownEvent(eventType: string): boolean {
    return eventType === 'AI_ANALYSIS' || eventType === 'AI_RECOMMENDATION';
  }

  formatEventType(type: string): string {
    const labels: Record<string, string> = {
      COMMENT: 'Comment',
      STATUS_CHANGE: 'Status Change',
      PRIORITY_CHANGE: 'Priority Change',
      CATEGORY_CHANGE: 'Category Change',
      AI_ANALYSIS: 'AI Analysis',
      AI_RECOMMENDATION: 'AI Recommendation',
      EMAIL_INBOUND: 'Email Received',
      EMAIL_OUTBOUND: 'Email Sent',
      CODE_CHANGE: 'Code Change',
      SYSTEM_NOTE: 'System Note',
    };
    return labels[type] ?? type;
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

  // ─── AI Recommendation / Probe Data helpers ───

  hasActionsMeta(event: TicketEvent): boolean {
    const meta = event.metadata as Record<string, unknown> | null;
    return Array.isArray(meta?.['actions']);
  }

  getEventActions(event: TicketEvent): Array<{ action: string; value?: string; reason: string; outcome?: string; pendingActionId?: string; recommendationType?: string }> {
    const meta = event.metadata as Record<string, unknown> | null;
    const actions = meta?.['actions'] as unknown[] | undefined;
    if (!Array.isArray(actions)) return [];
    return actions.map((a) => {
      const obj = a as Record<string, unknown>;
      return {
        action: (obj['action'] as string) ?? '',
        value: obj['value'] as string | undefined,
        reason: (obj['reason'] as string) ?? '',
        outcome: (obj['outcome'] as string) ?? (obj['applied'] === true ? 'auto_executed' : obj['applied'] === false ? 'skipped' : undefined),
        pendingActionId: obj['pendingActionId'] as string | undefined,
        recommendationType: obj['recommendationType'] as string | undefined,
      };
    });
  }

  getActionOutcome(act: { outcome?: string; applied?: boolean }): string {
    if (act.outcome) return act.outcome;
    if (act.applied === true) return 'auto_executed';
    return 'skipped';
  }

  getActionOutcomeLabel(act: { outcome?: string; applied?: boolean }): string {
    const outcome = this.getActionOutcome(act);
    const labels: Record<string, string> = {
      auto_executed: 'Auto-executed',
      pending_approval: 'Pending Approval',
      skipped: 'Skipped',
      dismissed: 'Dismissed',
      approved: 'Approved',
    };
    return labels[outcome] ?? outcome;
  }

  recActionIcon(action: string): string {
    const icons: Record<string, string> = {
      set_status: 'swap_horiz',
      set_priority: 'priority_high',
      set_category: 'category',
      add_comment: 'comment',
      trigger_code_fix: 'code',
      send_followup_email: 'email',
      escalate_deep_analysis: 'psychology',
      check_database_health: 'monitor_heart',
      assign_operator: 'person',
    };
    return icons[action] ?? 'lightbulb';
  }

  formatRecActionType(action: string): string {
    const labels: Record<string, string> = {
      set_status: 'Change Status',
      set_priority: 'Change Priority',
      set_category: 'Change Category',
      add_comment: 'Add Comment',
      trigger_code_fix: 'Create Issue Job',
      send_followup_email: 'Send Email',
      escalate_deep_analysis: 'Escalate',
      check_database_health: 'Check DB Health',
      assign_operator: 'Assign Operator',
    };
    return labels[action] ?? action;
  }

  approvePendingAction(actionId?: string): void {
    if (!actionId) return;
    const ticketId = this.ticket()?.id;
    if (!ticketId) return;
    this.ticketService.approvePendingAction(ticketId, actionId).subscribe({
      next: () => {
        this.snackBar.open('Action approved', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
        this.load();
      },
      error: () => this.snackBar.open('Failed to approve action', 'OK', { duration: 5000 }),
    });
  }

  dismissPendingAction(actionId?: string): void {
    if (!actionId) return;
    const ticketId = this.ticket()?.id;
    if (!ticketId) return;
    this.ticketService.dismissPendingAction(ticketId, actionId).subscribe({
      next: () => {
        this.snackBar.open('Action dismissed', 'OK', { duration: 3000 });
        this.load();
      },
      error: () => this.snackBar.open('Failed to dismiss action', 'OK', { duration: 5000 }),
    });
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

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  /** Check if a timeline event was triggered by an AI recommendation auto-execution. */
  isAiTriggered(event: TicketEvent): boolean {
    const meta = event.metadata as Record<string, unknown> | null;
    return meta?.['triggeredBy'] === 'ai_recommendation';
  }

  /** Check if an AI_ANALYSIS event is from the agentic analysis phase (has rich metadata). */
  isAgenticAnalysis(event: TicketEvent): boolean {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta || event.eventType !== 'AI_ANALYSIS') return false;
    return meta['phase'] === 'agentic_analysis' || meta['phase'] === 'deep_analysis';
  }

  /** Extract structured metadata from agentic analysis events. */
  agenticMeta(event: TicketEvent): {
    taskType: string;
    iterationsRun: number;
    toolCallCount: number;
    toolCalls: Array<{ tool: string; system?: string; durationMs?: number; output?: string }>;
    sufficiencyStatus: string | null;
    sufficiencyConfidence: string | null;
    sufficiencyReason: string | null;
    sufficiencyQuestions: string[] | null;
    totalCostUsd: number | null;
  } | null {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta) return null;
    const toolCalls = (meta['toolCalls'] as Array<{ tool: string; system?: string; durationMs?: number; output?: string }>) ?? [];
    return {
      taskType: (meta['taskType'] as string) ?? 'DEEP_ANALYSIS',
      iterationsRun: (meta['iterationsRun'] as number) ?? (meta['iterationCount'] as number) ?? 0,
      toolCallCount: (meta['toolCallCount'] as number) ?? toolCalls.length,
      toolCalls,
      sufficiencyStatus: (meta['sufficiencyStatus'] as string) ?? null,
      sufficiencyConfidence: (meta['sufficiencyConfidence'] as string) ?? null,
      sufficiencyReason: (meta['sufficiencyReason'] as string) ?? null,
      sufficiencyQuestions: (meta['sufficiencyQuestions'] as string[]) ?? null,
      totalCostUsd: (meta['totalCostUsd'] as number) ?? null,
    };
  }

  /** Check if content looks like JSON (for SYSTEM_NOTE probe data detection). */
  isJsonContent(content: string | null): boolean {
    if (!content) return false;
    const trimmed = content.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  formatJson(content: string): string {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }

  /** Check if a log entry is an iteration header (matches "Agentic analysis iteration N/M"). */
  isIterationHeader(entry: UnifiedLogEntry): boolean {
    return !!(entry.message && /^Agentic analysis iteration \d+\/\d+/.test(entry.message));
  }

  /** Extract a display label from an iteration header log entry. */
  extractIterationLabel(entry: UnifiedLogEntry): string {
    const match = entry.message?.match(/^Agentic analysis iteration (\d+)\/(\d+)/);
    if (match) return `Iteration ${match[1]} of ${match[2]}`;
    return 'Iteration';
  }

  /** Check if a log entry falls within an agentic iteration (tool/reasoning entries). */
  isWithinIteration(entry: UnifiedLogEntry): boolean {
    if (!entry.message) return false;
    return /^Agentic (tool call|reasoning)/.test(entry.message);
  }

  /** Extract recommendation actions from AI_RECOMMENDATION metadata. */
  recommendationActions(event: TicketEvent): Array<{ action: string; applied: boolean; detail?: string }> | null {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta) return null;
    const actions = meta['actions'] as Array<{ action: string; applied: boolean; detail?: string }> | undefined;
    return actions && actions.length > 0 ? actions : null;
  }
}
