import { Component, DestroyRef, inject, OnInit, signal, input, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule, DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { TicketService, Ticket, TicketEvent, type PendingAction, type UnifiedLogEntry, type TicketCostSummary, type AiHelpResponse, type TicketArtifact } from '../../core/services/ticket.service';
import { LogSummaryService, type LogSummary } from '../../core/services/log-summary.service';
import { AiUsageService, type TicketCostResponse } from '../../core/services/ai-usage.service';
import { AiHelpDialogComponent } from '../../shared/components/ai-help-dialog.component';
import {
  CardComponent,
  BroncoButtonComponent,
  TabComponent,
  TabGroupComponent,
  SelectComponent,
  FormFieldComponent,
  TextareaComponent,
  DialogComponent,
  IconComponent,
} from '../../shared/components/index.js';
import { AiLogEntryComponent } from './ai-log-entry.component';
import { TicketDetailSummaryComponent } from './ticket-detail-summary.component.js';
import { TicketDetailResolutionComponent } from './ticket-detail-resolution.component.js';
import { TicketDetailDetailsComponent } from './ticket-detail-details.component.js';
import { TicketDetailKnowledgeComponent } from './ticket-detail-knowledge.component.js';
import { TicketDetailLogDigestComponent } from './ticket-detail-log-digest.component.js';
import { TicketDetailFlowComponent, type FlowNode } from './ticket-detail-flow.component.js';
import { TicketDetailCostComponent } from './ticket-detail-cost.component.js';
import { TicketDetailTimelineComponent } from './ticket-detail-timeline.component.js';
import { ToastService } from '../../core/services/toast.service';

interface StepGroup {
  stepName: string;
  status: 'running' | 'completed' | 'failed';
  entries: UnifiedLogEntry[];
  aggrInputTokens: number;
  aggrOutputTokens: number;
  aggrCostUsd: number;
  aiCallCount: number;
  expanded: boolean;
  taskRun?: number | null;
}

interface ConvTreeNode {
  entry: UnifiedLogEntry;
  children: ConvTreeNode[];
  depth: number;
}

interface ConvTreeNode {
  entry: UnifiedLogEntry;
  children: ConvTreeNode[];
  depth: number;
  collapsed: boolean;
}

@Component({
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    DatePipe,
    DecimalPipe,
    JsonPipe,
    FormsModule,
    CardComponent,
    BroncoButtonComponent,
    TabComponent,
    TabGroupComponent,
    SelectComponent,
    FormFieldComponent,
    TextareaComponent,
    DialogComponent,
    AiLogEntryComponent,
    AiHelpDialogComponent,
    TicketDetailSummaryComponent,
    TicketDetailResolutionComponent,
    TicketDetailDetailsComponent,
    TicketDetailKnowledgeComponent,
    TicketDetailLogDigestComponent,
    TicketDetailFlowComponent,
    TicketDetailCostComponent,
    TicketDetailTimelineComponent,
    IconComponent,
  ],
  template: `
    @if (ticket(); as t) {
      <div class="page-wrapper">
        <div class="page-header">
          <div class="header-left">
            <a routerLink="/tickets" class="back-link"><app-icon name="back" size="sm" /> Tickets</a>
            <h1 class="page-title">
              @if (t.ticketNumber) { <span class="ticket-number">#{{ t.ticketNumber }}</span> }
              {{ t.subject }}
            </h1>
          </div>
        </div>

        <div class="ticket-meta">
          <app-form-field label="Priority">
            <app-select
              [value]="t.priority"
              [options]="priorityOptions"
              (valueChange)="updateField('priority', $event)" />
          </app-form-field>
          <app-form-field label="Status">
            <app-select
              [value]="t.status"
              [options]="statusOptions"
              (valueChange)="updateStatus($event)" />
          </app-form-field>
          <app-form-field label="Category">
            <app-select
              [value]="t.category ?? ''"
              [options]="categoryOptions"
              (valueChange)="updateField('category', $event || null)" />
          </app-form-field>
          <span class="source">via {{ t.source }}</span>
          <span class="date">{{ t.createdAt | date:'medium' }}</span>
          <span class="analysis-badge analysis-{{ t.analysisStatus.toLowerCase() }}">
            @if (t.analysisStatus === 'IN_PROGRESS') {
              <app-icon name="spinner" size="sm" class="spin-icon" />
            }
            {{ formatAnalysisStatus(t.analysisStatus) }}
            @if (t.analysisStatus === 'COMPLETED' && t.lastAnalyzedAt) {
              <span class="analysis-time">{{ t.lastAnalyzedAt | date:'short' }}</span>
            }
          </span>
          @if (t.analysisStatus === 'FAILED') {
            <app-bronco-button variant="destructive" size="sm" (click)="reanalyze()" [disabled]="reanalyzing()">
              <app-icon name="refresh" size="sm" /> Retry Analysis
            </app-bronco-button>
          }
        </div>

        @if (t.analysisStatus === 'FAILED' && t.analysisError) {
          <div class="analysis-error">
            <app-icon name="warning" size="sm" class="error-icon" />
            <span>{{ t.analysisError }}</span>
          </div>
        }

        @if (flowNodes().length > 0) {
          <app-ticket-detail-flow [nodes]="flowNodes()" />
        }

        <app-tab-group
          class="info-tabs"
          [selectedIndex]="selectedTabIndex()"
          (selectedIndexChange)="onTabIndexChange($event)">
          <app-tab label="AI Cost">
            <app-ticket-detail-cost [cost]="ticketCost()" />
          </app-tab>
          @if (emailBlurb()) {
            <app-tab label="AI Summary">
              <app-ticket-detail-summary [emailBlurb]="emailBlurb()!" />
            </app-tab>
          }
          @if (t.summary) {
            <app-tab label="Resolution Summary">
              <app-ticket-detail-resolution [summary]="t.summary" />
            </app-tab>
          }
          <app-tab label="Details">
            <app-ticket-detail-details
              [description]="t.description"
              [systemName]="t.system?.name ?? null"
              [clientName]="t.client?.name ?? null" />
          </app-tab>
          @if (t.knowledgeDoc || editingKnowledgeDoc()) {
            <app-tab label="Knowledge">
              <app-ticket-detail-knowledge
                [knowledgeDoc]="t.knowledgeDoc ?? null"
                [editing]="editingKnowledgeDoc()"
                (startEdit)="editingKnowledgeDoc.set(true)"
                (cancelEdit)="editingKnowledgeDoc.set(false)"
                (save)="saveKnowledgeDoc($event)"
                (clear)="clearKnowledgeDoc()" />
            </app-tab>
          }
          <app-tab [label]="logsTabLabel()">
            <div class="logs-view-toggle">
              <button class="view-btn" [class.view-active]="logsView() === 'conversation'" (click)="setLogsView('conversation')">Conversation</button>
              <button class="view-btn" [class.view-active]="logsView() === 'raw'" (click)="setLogsView('raw')">Raw Logs</button>
            </div>

            @if (logsView() === 'raw') {
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
              <app-form-field label="Type">
                <app-select
                  [value]="unifiedTypeFilter()"
                  [options]="typeFilterOptions"
                  (valueChange)="unifiedTypeFilter.set($event); loadUnifiedLogs()" />
              </app-form-field>
              <app-form-field label="Level">
                <app-select
                  [value]="logsLevelFilter()"
                  [options]="levelFilterOptions"
                  (valueChange)="logsLevelFilter.set($event); loadUnifiedLogs()" />
              </app-form-field>
              <app-form-field label="Search">
                <input
                  type="text"
                  class="search-input"
                  [(ngModel)]="logsSearchInput"
                  (keyup.enter)="onSearchEnter()" />
              </app-form-field>
              <app-bronco-button variant="icon" size="md" ariaLabel="Search" (click)="onSearchEnter()">
                <app-icon name="search" size="sm" />
              </app-bronco-button>
              <app-bronco-button variant="icon" size="md" ariaLabel="Refresh" (click)="loadUnifiedLogs()">
                <app-icon name="refresh" size="sm" />
              </app-bronco-button>
            </div>

            @if (unifiedLogsLoading()) {
              <div class="indeterminate-bar"><span class="indeterminate-track"></span></div>
            }

            <!-- Unified log stream -->
            <div class="logs-list">
              <!-- Ungrouped entries (before first step) -->
              @for (entry of ungroupedEntries(); track entry.id; let idx = $index) {
                @if (isIterationHeader(entry)) {
                  <div class="iteration-group-header">
                    <app-icon name="refresh" size="xs" class="iteration-icon" />
                    <span class="iteration-label">{{ extractIterationLabel(entry) }}</span>
                    <span class="log-seq">#{{ idx + 1 }}</span>
                    <span class="log-time" [attr.title]="entry.timestamp">{{ formatTime(entry.timestamp) }}</span>
                  </div>
                } @else if (entry.type === 'ai') {
                  <app-ai-log-entry [entry]="entry" [idx]="idx" [iterationGrouped]="isWithinIteration(entry)" />
                } @else {
                  <div class="log-entry" [ngClass]="'unified-type-' + entry.type" [class.iteration-grouped]="isWithinIteration(entry)">
                    <div class="log-entry-header">
                      <span class="log-seq">#{{ idx + 1 }}</span>
                      <span class="log-time" [attr.title]="entry.timestamp">{{ formatTime(entry.timestamp) }}</span>
                      <span class="unified-type-badge" [ngClass]="'ubadge-' + entry.type">{{ entry.type | uppercase }}</span>
                      @if (entry.level) { <span class="log-level-badge log-badge-{{ entry.level.toLowerCase() }}">{{ entry.level }}</span> }
                      @if (entry.service) { <span class="log-service">{{ entry.service }}</span> }
                      <span class="log-message">{{ entry.message }}</span>
                      @if (entry.context?.['artifactId']) {
                        <a class="artifact-link" [href]="ticketService.getArtifactDownloadUrl('' + entry.context!['artifactId'])" download>&#x2B73; Full output</a>
                      }
                    </div>
                    @if (entry.context && hasKeys(entry.context)) {
                      <app-bronco-button variant="ghost" size="sm" class="log-expand-btn" (click)="expandedLogs[entry.id] = !expandedLogs[entry.id]">
                        {{ expandedLogs[entry.id] ? 'Hide metadata' : 'Show metadata' }}
                        <app-icon [name]="expandedLogs[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                      </app-bronco-button>
                      @if (expandedLogs[entry.id]) { <pre class="log-metadata">{{ entry.context | json }}</pre> }
                    }
                    @if (entry.error) { <div class="log-error-detail">{{ entry.error }}</div> }
                  </div>
                }
              }

              <!-- Step groups -->
              @for (group of stepGroups(); track $index) {
                <div class="step-group">
                  <div class="step-group-header" (click)="group.expanded = !group.expanded">
                    <span class="step-status-icon"
                          [class.status-completed]="group.status === 'completed'"
                          [class.status-failed]="group.status === 'failed'"
                          [class.status-running]="group.status === 'running'"
                          aria-hidden="true">
                      <app-icon [name]="group.status === 'completed' ? 'check' : group.status === 'failed' ? 'close' : 'pending'" size="xs" />
                    </span>
                    <span class="step-name">{{ group.stepName }}</span>
                    @if (group.aiCallCount > 0) {
                      <span class="step-meta-chip">{{ group.aiCallCount }} AI call{{ group.aiCallCount > 1 ? 's' : '' }}</span>
                      <span class="step-meta-chip token-chip">{{ group.aggrInputTokens | number }}in / {{ group.aggrOutputTokens | number }}out</span>
                      @if (group.aggrCostUsd > 0) {
                        <span class="step-meta-chip cost-chip">\${{ group.aggrCostUsd | number:'1.4-4' }}</span>
                      }
                    }
                    <span class="step-entry-count">{{ group.entries.length }} entr{{ group.entries.length === 1 ? 'y' : 'ies' }}</span>
                    <app-icon [name]="group.expanded ? 'chevron-up' : 'chevron-down'" size="xs" class="step-chevron" />
                  </div>
                  @if (group.expanded) {
                    <div class="step-group-entries">
                      @for (entry of group.entries; track entry.id; let idx = $index) {
                        @if (isIterationHeader(entry)) {
                          <div class="iteration-group-header">
                            <app-icon name="refresh" size="xs" class="iteration-icon" />
                            <span class="iteration-label">{{ extractIterationLabel(entry) }}</span>
                            <span class="log-time" [attr.title]="entry.timestamp">{{ formatTime(entry.timestamp) }}</span>
                          </div>
                        } @else {
                          <div class="log-entry" [ngClass]="'unified-type-' + entry.type" [class.iteration-grouped]="isWithinIteration(entry)">
                            <div class="log-entry-header">
                              <span class="log-seq">#{{ idx + 1 }}</span>
                              <span class="log-time" [attr.title]="entry.timestamp">{{ formatTime(entry.timestamp) }}</span>
                              <span class="unified-type-badge" [ngClass]="'ubadge-' + entry.type">{{ entry.type | uppercase }}</span>
                              @if (entry.type === 'ai') {
                                <span class="meta-chip provider-chip provider-{{ (entry.provider ?? '').toLowerCase() }}">{{ entry.provider }}</span>
                                <code class="meta-chip model-chip">{{ entry.model }}</code>
                                <span class="meta-chip task-chip">{{ entry.taskType }}</span>
                                <span class="meta-chip token-chip">{{ entry.inputTokens | number }}in / {{ entry.outputTokens | number }}out</span>
                                @if (entry.durationMs != null) { <span class="meta-chip duration-chip">{{ entry.durationMs | number }}ms</span> }
                                @if (entry.costUsd != null) { <span class="ai-usage-cost">\${{ entry.costUsd | number:'1.4-4' }}</span> }
                              }
                              @if (entry.type !== 'ai') {
                                @if (entry.level) { <span class="log-level-badge log-badge-{{ entry.level.toLowerCase() }}">{{ entry.level }}</span> }
                                @if (entry.service) { <span class="log-service">{{ entry.service }}</span> }
                                <span class="log-message">{{ entry.message }}</span>
                                @if (entry.context?.['artifactId']) {
                                  <a class="artifact-link" [href]="ticketService.getArtifactDownloadUrl('' + entry.context!['artifactId'])" download>&#x2B73; Full output</a>
                                }
                              }
                            </div>
                            @if (entry.type === 'ai') {
                              <app-bronco-button variant="ghost" size="sm" class="log-expand-btn" (click)="expandedLogs[entry.id] = !expandedLogs[entry.id]">
                                {{ expandedLogs[entry.id] ? 'Hide details' : 'Show details' }}
                                <app-icon [name]="expandedLogs[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                              </app-bronco-button>
                              @if (expandedLogs[entry.id]) {
                                <div class="ai-detail-sections">
                                  @if (entry.promptKey) { <div class="ai-detail-label">Prompt Key: <code>{{ entry.promptKey }}</code></div> }
                                  @if (entry.archive?.fullPrompt || entry.promptText) {
                                    <div class="ai-detail-block"><div class="ai-detail-label">Prompt</div><pre class="log-metadata">{{ entry.archive?.fullPrompt ?? entry.promptText }}</pre></div>
                                  }
                                  @if (entry.archive?.systemPrompt || entry.systemPrompt) {
                                    <div class="ai-detail-block"><div class="ai-detail-label">System Prompt</div><pre class="log-metadata">{{ entry.archive?.systemPrompt ?? entry.systemPrompt }}</pre></div>
                                  }
                                  @if (entry.archive?.fullResponse || entry.responseText) {
                                    <div class="ai-detail-block"><div class="ai-detail-label">Response</div><pre class="log-metadata">{{ entry.archive?.fullResponse ?? entry.responseText }}</pre></div>
                                  }
                                  @if (entry.conversationMetadata) {
                                    <div class="ai-detail-block"><div class="ai-detail-label">Conversation Metadata</div><pre class="log-metadata">{{ entry.conversationMetadata | json }}</pre></div>
                                  }
                                  @if (entry.archive?.messageCount != null) {
                                    <div class="ai-detail-label">Messages: {{ entry.archive?.messageCount }} &middot; Context tokens: {{ entry.archive?.totalContextTokens | number }}</div>
                                  }
                                </div>
                              }
                            }
                            @if (entry.type !== 'ai') {
                              @if (entry.context && hasKeys(entry.context)) {
                                <app-bronco-button variant="ghost" size="sm" class="log-expand-btn" (click)="expandedLogs[entry.id] = !expandedLogs[entry.id]">
                                  {{ expandedLogs[entry.id] ? 'Hide metadata' : 'Show metadata' }}
                                  <app-icon [name]="expandedLogs[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                                </app-bronco-button>
                                @if (expandedLogs[entry.id]) { <pre class="log-metadata">{{ entry.context | json }}</pre> }
                              }
                              @if (entry.error) { <div class="log-error-detail">{{ entry.error }}</div> }
                            }
                          </div>
                        }
                      }
                    </div>
                  }
                </div>
              }

              @if (ungroupedEntries().length === 0 && stepGroups().length === 0 && !unifiedLogsLoading()) {
                <p class="empty">No logs found for this ticket.</p>
              }
            </div>

            <!-- Pagination -->
            @if (unifiedLogsTotal() > unifiedLogs().length) {
              <div class="logs-pagination">
                <span class="logs-showing">Showing {{ unifiedLogs().length }} of {{ unifiedLogsTotal() }}</span>
                <app-bronco-button variant="secondary" size="sm" (click)="loadMoreUnifiedLogs()">Load more</app-bronco-button>
              </div>
            }
            } @else {
            @if (conversationLoading()) {
              <div class="indeterminate-bar"><span class="indeterminate-track"></span></div>
            } @else if (!conversationLoaded()) {
              <div class="conv-empty">
                <p>Activate this tab to load conversation.</p>
              </div>
            } @else if (conversationEntries().length === 0) {
              <div class="conv-empty"><p>No AI calls recorded for this ticket.</p></div>
            } @else if (hasLineageData()) {
              <!-- Tree view — new data with parentLogId lineage -->
              <div class="conv-view">
                @for (item of convTreeFlat(); track item.node.entry.id) {
                  @if (item.visible) {
                    @let entry = item.node.entry;
                    @let node = item.node;
                    <div class="conv-tree-node" [style.margin-left.px]="node.depth * 24">
                      @if (entry.type === 'ai') {
                        <div class="conv-ai-block">
                          <div class="conv-ai-header">
                            @if (node.children.length > 0) {
                              <button type="button" class="conv-collapse-btn" (click)="toggleConvNode(node)" [attr.aria-label]="node.collapsed ? 'Expand' : 'Collapse'" [attr.aria-expanded]="!node.collapsed">
                                <app-icon [name]="node.collapsed ? 'chevron-right' : 'chevron-down'" size="xs" />
                              </button>
                            }
                            @if (node.depth > 0) { <app-icon name="subdirectory" size="xs" class="subtask-icon" /> }
                            <span class="conv-task-type">{{ entry.taskType }}</span>
                            <span class="conv-model">{{ entry.model }}</span>
                            <span class="conv-tokens">{{ entry.inputTokens | number }}in / {{ entry.outputTokens | number }}out</span>
                            @if (entry.costUsd != null) { <span class="conv-cost">\${{ entry.costUsd | number:'1.4-4' }}</span> }
                          </div>
                          @if (convMessages(entry).length > 0) {
                            <div class="conv-turns">
                              @for (turn of convMessages(entry); track $index) {
                                <div class="conv-turn" [ngClass]="'conv-turn-' + turn.role">
                                  <app-icon [name]="turn.role === 'user' ? 'user' : 'robot'" size="xs" class="conv-turn-role" />
                                  @if (turn.toolName) { <span class="conv-tool-call"><app-icon name="wrench" size="xs" /> {{ turn.toolName }}</span> }
                                  @if (turn.tokenCount) { <span class="conv-token-count">{{ turn.tokenCount | number }} tokens</span> }
                                </div>
                              }
                            </div>
                          }
                          @if (entry.archive?.fullPrompt || entry.promptText) {
                            <div class="conv-final-response conv-prompt-block">
                              <span class="conv-final-label">Prompt</span>
                              <pre class="conv-response-text" [class.clamped]="!convPromptExpanded[entry.id]">{{ convPromptText(entry) }}</pre>
                              @if (isMultilineConvPrompt(entry)) {
                                <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convPromptExpanded[entry.id] = !convPromptExpanded[entry.id]">
                                  {{ convPromptExpanded[entry.id] ? 'less' : 'more' }}
                                  <app-icon [name]="convPromptExpanded[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                                </app-bronco-button>
                              }
                            </div>
                          }
                          @if (entry.archive?.fullResponse || entry.responseText) {
                            <div class="conv-final-response">
                              <span class="conv-final-label">Response</span>
                              <pre class="conv-response-text" [class.clamped]="!convExpanded[entry.id]">{{ convResponseText(entry) }}</pre>
                              @if (isMultilineConv(entry)) {
                                <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convExpanded[entry.id] = !convExpanded[entry.id]">
                                  {{ convExpanded[entry.id] ? 'less' : 'more' }}
                                  <app-icon [name]="convExpanded[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                                </app-bronco-button>
                              }
                            </div>
                          }
                        </div>
                      } @else if (entry.type === 'tool' || entry.type === 'log' || entry.type === 'step' || entry.type === 'error') {
                        <div class="conv-tool-node" [class.conv-tool-error]="entry.type === 'error'">
                          <app-icon [name]="entry.type === 'error' ? 'close' : entry.type === 'step' ? 'pending' : 'wrench'" size="xs" class="conv-tool-icon" />
                          <span class="conv-tool-msg">{{ entry.message }}</span>
                          @if (entry.durationMs != null) { <span class="conv-tool-dur">{{ entry.durationMs }}ms</span> }
                        </div>
                      }
                    </div>
                  }
                }
              </div>
            } @else {
              <!-- Legacy view: flat grouping by step + orchestrationId -->
              <div class="conv-view">
                @if (hasTreeData()) {
                <!-- Tree view: entries linked by parentLogId -->
                @for (node of flattenTree(convTreeRoots()); track node.entry.id) {
                  <div class="conv-tree-node" [style.padding-left.px]="node.depth * 20">
                    @if (node.entry.type === 'ai') {
                      <div class="conv-ai-block">
                        <div class="conv-ai-header">
                          @if (node.children.length > 0) {
                            <button class="conv-collapse-btn" (click)="toggleCollapse(node.entry.id)" [attr.aria-expanded]="!isCollapsed(node.entry.id)">
                              {{ isCollapsed(node.entry.id) ? '\u25B6' : '\u25BC' }}
                            </button>
                          }
                          <span class="conv-task-type">{{ node.entry.taskType }}</span>
                          <span class="conv-model">{{ node.entry.model }}</span>
                          <span class="conv-tokens">{{ node.entry.inputTokens | number }}in / {{ node.entry.outputTokens | number }}out</span>
                          @if (node.entry.costUsd != null) { <span class="conv-cost">\${{ node.entry.costUsd | number:'1.4-4' }}</span> }
                          @if (node.children.length > 0) { <span class="conv-child-count">({{ node.children.length }})</span> }
                        </div>
                        @if (convMessages(node.entry).length > 0) {
                          <div class="conv-turns">
                            @for (turn of convMessages(node.entry); track $index) {
                              <div class="conv-turn" [ngClass]="'conv-turn-' + turn.role">
                                <span class="conv-turn-role">{{ turn.role === 'user' ? '\u{1F464}' : '\u{1F916}' }}</span>
                                @if (turn.toolName) { <span class="conv-tool-call">\u{1F527} {{ turn.toolName }}</span> }
                                @if (turn.tokenCount) { <span class="conv-token-count">{{ turn.tokenCount | number }} tokens</span> }
                              </div>
                            }
                          </div>
                        }
                        @if (node.entry.archive?.fullPrompt || node.entry.promptText) {
                          <div class="conv-final-response conv-prompt-block">
                            <span class="conv-final-label">Prompt</span>
                            <pre class="conv-response-text" [class.clamped]="!convPromptExpanded[node.entry.id]">{{ convPromptText(node.entry) }}</pre>
                            @if (isMultilineConvPrompt(node.entry)) {
                              <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convPromptExpanded[node.entry.id] = !convPromptExpanded[node.entry.id]">
                                {{ convPromptExpanded[node.entry.id] ? 'less' : 'more' }}
                                <span aria-hidden="true">{{ convPromptExpanded[node.entry.id] ? '\u23F6' : '\u23F7' }}</span>
                              </app-bronco-button>
                            }
                          </div>
                        }
                        @if (node.entry.archive?.fullResponse || node.entry.responseText) {
                          <div class="conv-final-response">
                            <span class="conv-final-label">Response</span>
                            <pre class="conv-response-text" [class.clamped]="!convExpanded[node.entry.id]">{{ convResponseText(node.entry) }}</pre>
                            @if (isMultilineConv(node.entry)) {
                              <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convExpanded[node.entry.id] = !convExpanded[node.entry.id]">
                                {{ convExpanded[node.entry.id] ? 'less' : 'more' }}
                                <span aria-hidden="true">{{ convExpanded[node.entry.id] ? '\u23F6' : '\u23F7' }}</span>
                              </app-bronco-button>
                            }
                          </div>
                        }
                      </div>
                    } @else if (node.entry.type === 'tool') {
                      <div class="conv-tool-entry">
                        <span class="conv-tool-icon" aria-hidden="true">\u{1F527}</span>
                        <span class="conv-tool-msg">{{ node.entry.message }}</span>
                        @if (node.entry.context?.['artifactId']) {
                          <a class="artifact-link" [href]="ticketService.getArtifactDownloadUrl('' + node.entry.context!['artifactId'])" download>&#x2B73; Full output</a>
                        }
                      </div>
                    } @else {
                      <div class="conv-log-entry conv-log-{{ node.entry.level?.toLowerCase() ?? 'info' }}">
                        <span class="conv-log-msg">{{ node.entry.message }}</span>
                      </div>
                    }
                  </div>
                }
                } @else {
                <!-- Legacy flat view: step groups + orchestration fallback -->
                @for (group of convStepGroups(); track $index) {
                  <div class="conv-step-section">
                    <div class="conv-step-label">
                      <app-icon [name]="group.status === 'completed' ? 'check' : group.status === 'failed' ? 'close' : 'pending'" size="xs" class="conv-step-icon" />
                      {{ group.stepName }}
                    </div>
                    @for (entry of group.entries; track entry.id) {
                      @if (entry.type === 'ai' && !isSubTask(entry)) {
                        <div class="conv-ai-block">
                          <div class="conv-ai-header">
                            <span class="conv-task-type">{{ entry.taskType }}</span>
                            <span class="conv-model">{{ entry.model }}</span>
                            <span class="conv-tokens">{{ entry.inputTokens | number }}in / {{ entry.outputTokens | number }}out</span>
                            @if (entry.costUsd != null) { <span class="conv-cost">\${{ entry.costUsd | number:'1.4-4' }}</span> }
                          </div>
                          @if (convMessages(entry).length > 0) {
                            <div class="conv-turns">
                              @for (turn of convMessages(entry); track $index) {
                                <div class="conv-turn" [ngClass]="'conv-turn-' + turn.role">
                                  <app-icon [name]="turn.role === 'user' ? 'user' : 'robot'" size="xs" class="conv-turn-role" />
                                  @if (turn.toolName) { <span class="conv-tool-call"><app-icon name="wrench" size="xs" /> {{ turn.toolName }}</span> }
                                  @if (turn.tokenCount) { <span class="conv-token-count">{{ turn.tokenCount | number }} tokens</span> }
                                </div>
                              }
                            </div>
                          }
                          @if (entry.archive?.fullPrompt || entry.promptText) {
                            <div class="conv-final-response conv-prompt-block">
                              <span class="conv-final-label">Prompt</span>
                              <pre class="conv-response-text" [class.clamped]="!convPromptExpanded[entry.id]">{{ convPromptText(entry) }}</pre>
                              @if (isMultilineConvPrompt(entry)) {
                                <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convPromptExpanded[entry.id] = !convPromptExpanded[entry.id]">
                                  {{ convPromptExpanded[entry.id] ? 'less' : 'more' }}
                                  <app-icon [name]="convPromptExpanded[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                                </app-bronco-button>
                              }
                            </div>
                          }
                          @if (entry.archive?.fullResponse || entry.responseText) {
                            <div class="conv-final-response">
                              <span class="conv-final-label">Response</span>
                              <pre class="conv-response-text" [class.clamped]="!convExpanded[entry.id]">{{ convResponseText(entry) }}</pre>
                              @if (isMultilineConv(entry)) {
                                <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convExpanded[entry.id] = !convExpanded[entry.id]">
                                  {{ convExpanded[entry.id] ? 'less' : 'more' }}
                                  <app-icon [name]="convExpanded[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                                </app-bronco-button>
                              }
                            </div>
                          }
                          <!-- Nested sub-tasks (legacy orchestration-based) -->
                          @if (getOrchestrationId(entry); as orchestrationId) {
                            @for (sub of getSubTasks(group.entries, orchestrationId); track sub.id) {
                              <div class="conv-subtask">
                                <div class="conv-ai-header">
                                  <app-icon name="subdirectory" size="xs" class="subtask-icon" />
                                  <span class="conv-task-type">{{ sub.taskType }}</span>
                                  <span class="conv-model">{{ sub.model }}</span>
                                  <span class="conv-tokens">{{ sub.inputTokens | number }}in / {{ sub.outputTokens | number }}out</span>
                                  @if (sub.costUsd != null) { <span class="conv-cost">\${{ sub.costUsd | number:'1.4-4' }}</span> }
                                </div>
                                @if (sub.archive?.fullPrompt || sub.promptText) {
                                  <div class="conv-final-response conv-prompt-block">
                                    <span class="conv-final-label">Prompt</span>
                                    <pre class="conv-response-text" [class.clamped]="!convPromptExpanded[sub.id]">{{ convPromptText(sub) }}</pre>
                                    @if (isMultilineConvPrompt(sub)) {
                                      <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convPromptExpanded[sub.id] = !convPromptExpanded[sub.id]">
                                        {{ convPromptExpanded[sub.id] ? 'less' : 'more' }}
                                        <app-icon [name]="convPromptExpanded[sub.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                                      </app-bronco-button>
                                    }
                                  </div>
                                }
                                @if (sub.archive?.fullResponse || sub.responseText) {
                                  <div class="conv-final-response">
                                    <span class="conv-final-label">Response</span>
                                    <pre class="conv-response-text" [class.clamped]="!convExpanded[sub.id]">{{ convResponseText(sub) }}</pre>
                                    @if (isMultilineConv(sub)) {
                                      <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convExpanded[sub.id] = !convExpanded[sub.id]">
                                        {{ convExpanded[sub.id] ? 'less' : 'more' }}
                                        <app-icon [name]="convExpanded[sub.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                                      </app-bronco-button>
                                    }
                                  </div>
                                }
                              </div>
                            }
                          }
                        </div>
                      }
                    }
                  </div>
                }
                @for (entry of convUngrouped(); track entry.id) {
                  @if (entry.type === 'ai') {
                    <div class="conv-ai-block">
                      <div class="conv-ai-header">
                        <span class="conv-task-type">{{ entry.taskType }}</span>
                        <span class="conv-model">{{ entry.model }}</span>
                        <span class="conv-tokens">{{ entry.inputTokens | number }}in / {{ entry.outputTokens | number }}out</span>
                        @if (entry.costUsd != null) { <span class="conv-cost">\${{ entry.costUsd | number:'1.4-4' }}</span> }
                      </div>
                      @if (convMessages(entry).length > 0) {
                        <div class="conv-turns">
                          @for (turn of convMessages(entry); track $index) {
                            <div class="conv-turn" [ngClass]="'conv-turn-' + turn.role">
                              <app-icon [name]="turn.role === 'user' ? 'user' : 'robot'" size="xs" class="conv-turn-role" />
                              @if (turn.toolName) { <span class="conv-tool-call"><app-icon name="wrench" size="xs" /> {{ turn.toolName }}</span> }
                              @if (turn.tokenCount) { <span class="conv-token-count">{{ turn.tokenCount | number }} tokens</span> }
                            </div>
                          }
                        </div>
                      }
                      @if (entry.archive?.fullPrompt || entry.promptText) {
                        <div class="conv-final-response conv-prompt-block">
                          <span class="conv-final-label">Prompt</span>
                          <pre class="conv-response-text" [class.clamped]="!convPromptExpanded[entry.id]">{{ convPromptText(entry) }}</pre>
                          @if (isMultilineConvPrompt(entry)) {
                            <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convPromptExpanded[entry.id] = !convPromptExpanded[entry.id]">
                              {{ convPromptExpanded[entry.id] ? 'less' : 'more' }}
                              <app-icon [name]="convPromptExpanded[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                            </app-bronco-button>
                          }
                        </div>
                      }
                      @if (entry.archive?.fullResponse || entry.responseText) {
                        <div class="conv-final-response">
                          <span class="conv-final-label">Response</span>
                          <pre class="conv-response-text" [class.clamped]="!convExpanded[entry.id]">{{ convResponseText(entry) }}</pre>
                          @if (isMultilineConv(entry)) {
                            <app-bronco-button variant="ghost" size="sm" class="inline-expand-btn" (click)="convExpanded[entry.id] = !convExpanded[entry.id]">
                              {{ convExpanded[entry.id] ? 'less' : 'more' }}
                              <app-icon [name]="convExpanded[entry.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                            </app-bronco-button>
                          }
                        </div>
                      }
                    </div>
                  }
                }
                }
              </div>
            }
            }
          </app-tab>
          <app-tab label="Log Digest">
            <app-ticket-detail-log-digest
              [summaries]="logSummaries()"
              [generating]="generatingLogs()"
              (generate)="generateLogSummary()" />
          </app-tab>
          <app-tab label="Artifacts">
            @if (!artifactsLoaded()) {
              <div class="load-prompt" (click)="loadArtifacts()">Activate to load artifacts</div>
            } @else if (artifacts().length === 0) {
              <div class="empty-state">No artifacts for this ticket.</div>
            } @else {
              <div class="artifacts-list">
                @for (a of artifacts(); track a.id) {
                  <div class="artifact-row">
                    <div class="artifact-info">
                      <span class="artifact-filename">{{ a.filename }}</span>
                      <span class="artifact-meta">{{ a.mimeType }} &middot; {{ formatBytes(a.sizeBytes) }} &middot; {{ formatTime(a.createdAt) }}</span>
                      @if (a.description) {
                        <span class="artifact-desc">{{ a.description }}</span>
                      }
                    </div>
                    <a class="artifact-dl" [href]="ticketService.getArtifactDownloadUrl(a.id)" download>
                      <span aria-hidden="true">&#x2B73;</span> Download
                    </a>
                  </div>
                }
              </div>
            }
          </app-tab>
          <app-tab label="Timeline">
            <app-ticket-detail-timeline
              [events]="events()"
              [pendingActionMap]="pendingActionMap()"
              (approveAction)="approvePendingAction($event)"
              (dismissAction)="dismissPendingAction($event)" />
            <app-card padding="md" class="add-comment">
              <app-form-field label="Add comment">
                <app-textarea
                  [value]="newComment"
                  [rows]="2"
                  (valueChange)="newComment = $event" />
              </app-form-field>
              <div class="comment-actions">
                <app-bronco-button variant="primary" (click)="addComment()" [disabled]="!newComment">
                  <span aria-hidden="true">&#x27A4;</span> Add Comment
                </app-bronco-button>
              </div>
            </app-card>
          </app-tab>
        </app-tab-group>

        <div class="reanalyze-bar">
          <app-bronco-button variant="secondary" (click)="reanalyze()" [disabled]="reanalyzing()">
            <app-icon name="refresh" size="sm" /> Re-run Analysis
          </app-bronco-button>
        </div>

        <button class="ai-fab" type="button" aria-label="Ask AI for Help" (click)="openAiHelp()">
          <app-icon name="sparkles" size="md" />
        </button>
      </div>
    } @else {
      <p class="loading">Loading...</p>
    }

    @if (showAiHelpDialog()) {
      <app-dialog [open]="true" [title]="aiHelpTitle()" maxWidth="600px" (openChange)="onAiHelpClosed()">
        <app-ai-help-dialog-content
          [submitFn]="aiHelpSubmitFn"
          (closed)="onAiHelpClosed()" />
      </app-dialog>
    }
  `,
  styleUrl: './ticket-detail.component.css',
})
export class TicketDetailComponent implements OnInit {
  id = input.required<string>();

  readonly ticketService = inject(TicketService);
  private logSummaryService = inject(LogSummaryService);
  private aiUsageService = inject(AiUsageService);
  private destroyRef = inject(DestroyRef);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  showAiHelpDialog = signal(false);
  aiHelpTitle = signal('');
  aiHelpSubmitFn: (params: { question?: string; provider?: string; model?: string }) => Promise<AiHelpResponse> = () => Promise.reject(new Error('not initialized'));

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL_MS = 4_000;
  private knownEventIds = new Set<string>();
  private knownUnifiedLogIds = new Set<string>();
  private lastUnifiedLogAt: string | null = null;

  ticket = signal<(Ticket & { client?: { name: string }; system?: { name: string } | null }) | null>(null);
  events = signal<TicketEvent[]>([]);
  logSummaries = signal<LogSummary[]>([]);
  ticketCost = signal<TicketCostResponse | null>(null);
  generatingLogs = signal(false);
  reanalyzing = signal(false);
  editingKnowledgeDoc = signal(false);
  newComment = '';
  logsSearchInput = '';

  // Unified logs tab state
  unifiedLogs = signal<UnifiedLogEntry[]>([]);
  unifiedLogsTotal = signal(0);
  unifiedLogsLoading = signal(false);
  unifiedTypeFilter = signal('');
  logsLevelFilter = signal('');
  logsSearchFilter = signal('');
  expandedLogs: Record<string, boolean> = {};
  costSummary = signal<TicketCostSummary | null>(null);
  pendingActionMap = signal<Record<string, string>>({});
  stepGroups = signal<StepGroup[]>([]);
  ungroupedEntries = signal<UnifiedLogEntry[]>([]);
  conversationEntries = signal<UnifiedLogEntry[]>([]);
  conversationLoading = signal(false);
  conversationLoaded = signal(false);
  convStepGroups = signal<StepGroup[]>([]);
  convUngrouped = signal<UnifiedLogEntry[]>([]);
  convExpanded: Record<string, boolean> = {};
  convPromptExpanded: Record<string, boolean> = {};
  convCollapsed: Record<string, boolean> = {};
  convTreeRoots = signal<ConvTreeNode[]>([]);
  convTreeFlat = computed<Array<{ node: ConvTreeNode; visible: boolean }>>(() => {
    const result: Array<{ node: ConvTreeNode; visible: boolean }> = [];
    const walk = (nodes: ConvTreeNode[], parentVisible: boolean) => {
      for (const node of nodes) {
        const visible = parentVisible;
        result.push({ node, visible });
        walk(node.children, visible && !node.collapsed);
      }
    };
    walk(this.convTreeRoots(), true);
    return result;
  });
  artifacts = signal<TicketArtifact[]>([]);
  artifactsLoaded = signal(false);

  // Tab tracking
  selectedTabIndex = signal(0);
  logsView = signal<'raw' | 'conversation'>('conversation');

  /** Dynamic tab labels (depends on which conditional tabs are visible). */
  tabsInOrder = computed<string[]>(() => {
    const t = this.ticket();
    const labels: string[] = [];
    labels.push('AI Cost');
    if (this.emailBlurb()) labels.push('AI Summary');
    if (t?.summary) labels.push('Resolution Summary');
    labels.push('Details');
    if (t?.knowledgeDoc || this.editingKnowledgeDoc()) labels.push('Knowledge');
    labels.push('Logs');
    labels.push('Log Digest');
    labels.push('Artifacts');
    labels.push('Timeline');
    return labels;
  });


  logsTabLabel = computed(() => {
    const total = this.unifiedLogsTotal();
    return total > 0 ? `Logs (${total})` : 'Logs';
  });

  // Static select option lists
  readonly priorityOptions = [
    { value: 'LOW', label: 'Low' },
    { value: 'MEDIUM', label: 'Medium' },
    { value: 'HIGH', label: 'High' },
    { value: 'CRITICAL', label: 'Critical' },
  ];
  readonly statusOptions = [
    { value: 'OPEN', label: 'Open' },
    { value: 'IN_PROGRESS', label: 'In Progress' },
    { value: 'WAITING', label: 'Waiting' },
    { value: 'RESOLVED', label: 'Resolved' },
    { value: 'CLOSED', label: 'Closed' },
  ];
  readonly categoryOptions = [
    { value: '', label: 'None' },
    { value: 'DATABASE_PERF', label: 'Database Perf' },
    { value: 'BUG_FIX', label: 'Bug Fix' },
    { value: 'FEATURE_REQUEST', label: 'Feature Request' },
    { value: 'SCHEMA_CHANGE', label: 'Schema Change' },
    { value: 'CODE_REVIEW', label: 'Code Review' },
    { value: 'ARCHITECTURE', label: 'Architecture' },
    { value: 'GENERAL', label: 'General' },
  ];
  readonly typeFilterOptions = [
    { value: '', label: 'All' },
    { value: 'ai', label: 'AI Calls' },
    { value: 'tool', label: 'Tool Calls' },
    { value: 'step', label: 'Steps' },
    { value: 'error', label: 'Errors' },
    { value: 'log', label: 'Logs' },
  ];
  readonly levelFilterOptions = [
    { value: '', label: 'All' },
    { value: 'ERROR', label: 'Error' },
    { value: 'WARN', label: 'Warn' },
    { value: 'INFO', label: 'Info' },
    { value: 'DEBUG', label: 'Debug' },
  ];

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
    this.loadPendingActions();
    this.destroyRef.onDestroy(() => this.stopPolling());

  }

  loadPendingActions(): void {
    this.ticketService.getPendingActions(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (actions: PendingAction[]) => {
        const map: Record<string, string> = {};
        for (const a of actions) map[a.id] = a.status;
        this.pendingActionMap.set(map);
      },
    });
  }

  private tabRestored = false;

  load(): void {
    this.ticketService.getTicket(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(t => {
      this.ticket.set(t);

      // Restore tab from query param on first load (after ticket is available so tabsInOrder is correct)
      if (!this.tabRestored) {
        this.tabRestored = true;
        const tabSlug = this.route.snapshot.queryParamMap.get('tab');
        if (tabSlug) {
          const labels = this.tabsInOrder();
          const idx = labels.findIndex(l => this.toSlug(l) === tabSlug);
          if (idx >= 0) {
            this.selectedTabIndex.set(idx);
          }
        }
        // Conversation is the default logs view — load it on first ticket load
        if (this.logsView() === 'conversation') {
          this.loadConversationEntries();
        }
      }
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
          this.buildStepGroups(res.entries);
          this.unifiedLogsTotal.set(res.total);
          this.unifiedLogsLoading.set(false);
          this.knownUnifiedLogIds.clear();
          for (const e of res.entries) this.knownUnifiedLogIds.add(e.id);
          if (res.entries.length > 0) {
            this.lastUnifiedLogAt = res.entries[res.entries.length - 1].timestamp;
          }
        },
        error: () => this.unifiedLogsLoading.set(false),
      });
  }

  private pollUnifiedLogs(): void {
    const filters: Record<string, string | number> = { limit: 200 };
    if (this.lastUnifiedLogAt) {
      filters['createdAfter'] = this.lastUnifiedLogAt;
    }
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
          const newEntries = res.entries.filter(e => !this.knownUnifiedLogIds.has(e.id));
          if (newEntries.length > 0) {
            this.unifiedLogs.update(current => [...current, ...newEntries]);
            this.unifiedLogsTotal.update(t => t + newEntries.length);
            this.lastUnifiedLogAt = newEntries[newEntries.length - 1].timestamp;
            for (const e of newEntries) this.knownUnifiedLogIds.add(e.id);
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
          const allEntries = [...current, ...res.entries];
          this.unifiedLogs.set(allEntries);
          this.buildStepGroups(allEntries);
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

  onSearchEnter(): void {
    this.logsSearchFilter.set(this.logsSearchInput);
    this.loadUnifiedLogs();
  }

  private buildGroups(entries: UnifiedLogEntry[]): { groups: StepGroup[]; ungrouped: UnifiedLogEntry[] } {
    const groups: StepGroup[] = [];
    const ungrouped: UnifiedLogEntry[] = [];
    let current: StepGroup | null = null;

    for (const entry of entries) {
      const msg = entry.message?.toLowerCase() ?? '';

      if (entry.type === 'step' && msg.includes('executing step')) {
        const match = entry.message?.match(/executing step[:\s]+(.+)/i);
        const stepName = match?.[1] ?? entry.message ?? 'STEP';
        current = {
          stepName,
          status: 'running',
          entries: [entry],
          aggrInputTokens: 0,
          aggrOutputTokens: 0,
          aggrCostUsd: 0,
          aiCallCount: 0,
          expanded: true,
          taskRun: entry.taskRun ?? null,
        };
        groups.push(current);
      } else if (entry.type === 'step' && (msg.includes('step completed') || msg.includes('step failed') || msg.includes('step skipped'))) {
        if (current) {
          current.status = msg.includes('failed') ? 'failed' : 'completed';
          current.entries.push(entry);
        }
      } else if (current) {
        // Match entries to groups: prefer taskRun (exact), fall back to taskType name match
        let target = current;
        if (entry.taskRun != null) {
          let match: StepGroup | undefined;
          for (let i = groups.length - 1; i >= 0; i--) {
            if (groups[i].taskRun === entry.taskRun) { match = groups[i]; break; }
          }
          if (match) target = match;
        } else if (entry.type === 'ai' && entry.taskType) {
          const tt = entry.taskType.toUpperCase();
          let match: StepGroup | undefined;
          for (let i = groups.length - 1; i >= 0; i--) {
            if (groups[i].stepName.toUpperCase().includes(tt)) { match = groups[i]; break; }
          }
          if (match) target = match;
        }
        target.entries.push(entry);
        if (entry.type === 'ai') {
          target.aiCallCount++;
          target.aggrInputTokens += entry.inputTokens ?? 0;
          target.aggrOutputTokens += entry.outputTokens ?? 0;
          target.aggrCostUsd += entry.costUsd ?? 0;
        }
      } else {
        ungrouped.push(entry);
      }
    }

    return { groups, ungrouped };
  }

  private buildStepGroups(entries: UnifiedLogEntry[]): void {
    const { groups, ungrouped } = this.buildGroups(entries);
    this.stepGroups.set(groups);
    this.ungroupedEntries.set(ungrouped);
  }

  private buildConvGroups(entries: UnifiedLogEntry[]): void {
    const { groups, ungrouped } = this.buildGroups(entries);
    this.convStepGroups.set(groups);
    this.convUngrouped.set(ungrouped);
    this.convTreeRoots.set(this.buildConvTree(entries));
  }

  hasTreeData(): boolean {
    return this.conversationEntries().some(e => !!e.parentLogId);
  }

  hasLineageData(): boolean {
    return this.hasTreeData();
  }

  toggleCollapse(id: string): void {
    this.convCollapsed[id] = !this.convCollapsed[id];
  }

  isCollapsed(id: string): boolean {
    return !!this.convCollapsed[id];
  }

  flattenTree(roots: ConvTreeNode[]): ConvTreeNode[] {
    const result: ConvTreeNode[] = [];
    const walk = (nodes: ConvTreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (!this.isCollapsed(node.entry.id)) {
          walk(node.children);
        }
      }
    };
    walk(roots);
    return result;
  }

  loadConversationEntries(): void {
    if (this.conversationLoaded()) return;
    const ticketId = this.ticket()?.id;
    if (!ticketId) return;
    this.conversationLoading.set(true);
    this.ticketService
      .getUnifiedLogs(ticketId, { limit: 200 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.conversationEntries.set(res.entries);
          this.buildConvGroups(res.entries);
          this.conversationLoading.set(false);
          this.conversationLoaded.set(true);
        },
        error: () => {
          this.conversationLoading.set(false);
        },
      });
  }

  onTabIndexChange(idx: number): void {
    this.selectedTabIndex.set(idx);
    const labels = this.tabsInOrder();
    // Persist tab in query param for refresh
    const slug = this.toSlug(labels[idx] ?? '');
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: slug || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  setLogsView(view: 'raw' | 'conversation'): void {
    this.logsView.set(view);
    if (view === 'conversation') {
      this.loadConversationEntries();
    }
  }

  private toSlug(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  isSubTask(entry: UnifiedLogEntry): boolean {
    return !!(entry.conversationMetadata as Record<string, unknown> | null)?.['isSubTask'];
  }

  getOrchestrationId(entry: UnifiedLogEntry): string | null {
    return ((entry.conversationMetadata as Record<string, unknown> | null)?.['orchestrationId'] as string) ?? null;
  }

  getSubTasks(entries: UnifiedLogEntry[], orchestrationId: string): UnifiedLogEntry[] {
    return entries.filter(e =>
      e.type === 'ai' && this.isSubTask(e) && this.getOrchestrationId(e) === orchestrationId
    );
  }

  /** Build a tree from parentLogId relationships. Returns root nodes. */
  private buildConvTree(entries: UnifiedLogEntry[]): ConvTreeNode[] {
    const nodeMap = new Map<string, ConvTreeNode>();
    const roots: ConvTreeNode[] = [];

    // Create nodes
    for (const entry of entries) {
      nodeMap.set(entry.id, { entry, children: [], depth: 0, collapsed: false });
    }

    // Link parents
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentLogId && nodeMap.has(entry.parentLogId)) {
        const parent = nodeMap.get(entry.parentLogId)!;
        parent.children.push(node);
        node.depth = parent.depth + 1;
      } else {
        roots.push(node);
      }
    }

    // Propagate depths (parents may have been processed after children)
    const setDepths = (node: ConvTreeNode, depth: number): void => {
      node.depth = depth;
      for (const child of node.children) {
        setDepths(child, depth + 1);
      }
    };
    for (const root of roots) setDepths(root, 0);

    return roots;
  }

  toggleConvNode(node: ConvTreeNode): void {
    node.collapsed = !node.collapsed;
    this.convTreeRoots.set([...this.convTreeRoots()]);
  }

  convMessages(entry: UnifiedLogEntry): Array<{ role: string; tokenCount?: number; toolName?: string }> {
    const meta = entry.conversationMetadata as { messages?: Array<{ role: string; tokenCount?: number; toolName?: string }> } | null;
    return meta?.messages ?? [];
  }

  convPromptText(entry: UnifiedLogEntry): string {
    return entry.archive?.fullPrompt ?? entry.promptText ?? '';
  }

  convResponseText(entry: UnifiedLogEntry): string {
    return entry.archive?.fullResponse ?? entry.responseText ?? '';
  }

  isMultilineConvPrompt(entry: UnifiedLogEntry): boolean {
    const text = this.convPromptText(entry);
    return text.split('\n').filter(l => l.trim().length > 0).length > 2;
  }

  isMultilineConv(entry: UnifiedLogEntry): boolean {
    const text = this.convResponseText(entry);
    return text.split('\n').filter(l => l.trim().length > 0).length > 2;
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
            this.toast.info('Log summary generated');
            this.loadLogSummaries();
          } else {
            this.toast.info('No new logs to summarize');
          }
        },
        error: () => {
          this.generatingLogs.set(false);
          this.toast.error('Failed to generate log summary');
        },
      });
  }

  loadArtifacts(): void {
    this.ticketService.getArtifacts(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (list) => {
        this.artifacts.set(list);
        this.artifactsLoaded.set(true);
      },
      error: () => this.toast.error('Failed to load artifacts'),
    });
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  updateStatus(status: string): void {
    this.ticketService.updateTicket(this.id(), { status } as never).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.success('Status updated');
        this.load();
      },
      error: () => this.toast.error('Failed to update'),
    });
  }

  updateField(field: 'priority' | 'category', value: string | null): void {
    this.ticketService.updateTicket(this.id(), { [field]: value } as never).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.success(`${field.charAt(0).toUpperCase() + field.slice(1)} updated`);
        this.load();
      },
      error: () => this.toast.error(`Failed to update ${field}`),
    });
  }

  saveKnowledgeDoc(draft: string): void {
    const doc = draft.trim() || null;
    this.ticketService.updateKnowledgeDoc(this.id(), doc).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.editingKnowledgeDoc.set(false);
        this.toast.success('Knowledge doc updated');
        this.load();
      },
      error: () => this.toast.error('Failed to update knowledge doc'),
    });
  }

  clearKnowledgeDoc(): void {
    if (!confirm('This will remove all investigation history. Continue?')) return;
    this.ticketService.updateKnowledgeDoc(this.id(), null).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.toast.success('Knowledge doc cleared');
        this.load();
      },
      error: () => this.toast.error('Failed to clear knowledge doc'),
    });
  }

  reanalyze(): void {
    this.reanalyzing.set(true);
    this.ticketService.reanalyze(this.id()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.reanalyzing.set(false);
        this.toast.success('Analysis re-queued');
        this.load();
      },
      error: () => {
        this.reanalyzing.set(false);
        this.toast.error('Failed to re-queue analysis');
      },
    });
  }

  openAiHelp(): void {
    const ticketId = this.id();
    const ticketSubject = this.ticket()?.subject ?? '';
    this.aiHelpTitle.set(`Ask AI — ${ticketSubject}`);
    this.aiHelpSubmitFn = (params) => firstValueFrom(this.ticketService.askAi(ticketId, params));
    this.showAiHelpDialog.set(true);
  }

  onAiHelpClosed(): void {
    this.showAiHelpDialog.set(false);
    this.load();
    this.loadTicketCost();
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
      error: () => this.toast.error('Failed to add comment'),
    });
  }

  approvePendingAction(actionId: string): void {
    if (!actionId) return;
    const ticketId = this.ticket()?.id;
    if (!ticketId) return;
    this.ticketService.approvePendingAction(ticketId, actionId).subscribe({
      next: () => {
        this.toast.success('Action approved');
        this.loadPendingActions();
        this.load();
      },
      error: () => this.toast.error('Failed to approve action'),
    });
  }

  dismissPendingAction(actionId: string): void {
    if (!actionId) return;
    const ticketId = this.ticket()?.id;
    if (!ticketId) return;
    this.ticketService.dismissPendingAction(ticketId, actionId).subscribe({
      next: () => {
        this.toast.success('Action dismissed');
        this.loadPendingActions();
        this.load();
      },
      error: () => this.toast.error('Failed to dismiss action'),
    });
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

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: true, hour: 'numeric', minute: '2-digit' });
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  isIterationHeader(entry: UnifiedLogEntry): boolean {
    return !!(entry.message && /^Agentic analysis iteration \d+\/\d+/.test(entry.message));
  }

  extractIterationLabel(entry: UnifiedLogEntry): string {
    const match = entry.message?.match(/^Agentic analysis iteration (\d+)\/(\d+)/);
    if (match) return `Iteration ${match[1]} of ${match[2]}`;
    return 'Iteration';
  }

  isWithinIteration(entry: UnifiedLogEntry): boolean {
    if (!entry.message) return false;
    return /^Agentic (tool call|reasoning)/.test(entry.message);
  }
}
