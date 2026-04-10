import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { CardComponent, BroncoButtonComponent, SelectComponent, FormFieldComponent, IconComponent, type IconName } from '../../shared/components/index.js';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';
import { RelativeTimePipe } from '../../shared/pipes/relative-time.pipe';
import { type TicketEvent } from '../../core/services/ticket.service';

@Component({
  selector: 'app-ticket-detail-timeline',
  standalone: true,
  imports: [
    CommonModule,
    DecimalPipe,
    CardComponent,
    BroncoButtonComponent,
    SelectComponent,
    FormFieldComponent,
    MarkdownPipe,
    RelativeTimePipe,
    IconComponent,
  ],
  template: `
    <div class="timeline-header">
      <h3 class="timeline-title">Timeline</h3>
      <div class="timeline-controls">
        <app-form-field label="Filter">
          <app-select
            [value]="timelineFilter()"
            [options]="filterOptions"
            (valueChange)="timelineFilter.set($event)" />
        </app-form-field>
        <app-bronco-button
          variant="icon"
          size="md"
          [ariaLabel]="timelineSortAsc() ? 'Oldest first' : 'Newest first'"
          (click)="toggleSort()">
          <app-icon [name]="timelineSortAsc() ? 'arrow-up' : 'arrow-down'" size="xs" />
        </app-bronco-button>
      </div>
    </div>

    <div class="timeline">
      @for (event of filteredEvents(); track event.id) {
        <app-card padding="md" class="event-card" [ngClass]="'event-type-' + event.eventType.toLowerCase()">
          <div class="event-header">
            <span class="event-type-badge" [ngClass]="'badge-' + event.eventType.toLowerCase()">
              <app-icon [name]="eventIconName(event.eventType)" size="sm" class="evt-icon" />
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
            <span class="event-date" [attr.title]="event.createdAt">{{ event.createdAt | relativeTime }}</span>
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

                @if (am.toolCalls.length > 0) {
                  <app-bronco-button variant="ghost" size="sm" (click)="toggleSection(event.id + ':tools')">
                    <app-icon [name]="expandedSections[event.id + ':tools'] ? 'chevron-up' : 'chevron-down'" size="xs" />
                    Tool Calls ({{ am.toolCalls.length }})
                  </app-bronco-button>
                  @if (expandedSections[event.id + ':tools']) {
                    <div class="tool-calls-list">
                      @for (tc of am.toolCalls; track $index) {
                        <div class="tool-call-row">
                          <span class="tool-name">{{ tc.tool }}</span>
                          @if (tc.system) { <span class="meta-chip provider-chip provider-local">{{ tc.system }}</span> }
                          @if (tc.durationMs != null) { <span class="meta-chip duration-chip">{{ tc.durationMs }}ms</span> }
                          @if (tc.output) {
                            <app-bronco-button variant="ghost" size="sm" (click)="toggleSection(event.id + ':tc:' + $index)">
                              {{ expandedSections[event.id + ':tc:' + $index] ? 'Hide' : 'Result' }}
                            </app-bronco-button>
                          }
                          @if (expandedSections[event.id + ':tc:' + $index] && tc.output) {
                            <pre class="tool-result">{{ tc.output }}</pre>
                          }
                        </div>
                      }
                    </div>
                  }
                }

                @if (am.sufficiencyReason) {
                  <app-bronco-button variant="ghost" size="sm" (click)="toggleSection(event.id + ':sufficiency')">
                    <app-icon [name]="expandedSections[event.id + ':sufficiency'] ? 'chevron-up' : 'chevron-down'" size="xs" />
                    Sufficiency
                  </app-bronco-button>
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

              @if (event.content) {
                <app-bronco-button variant="ghost" size="sm" (click)="toggleSection(event.id + ':analysis')">
                  <app-icon [name]="expandedSections[event.id + ':analysis'] ? 'chevron-up' : 'chevron-down'" size="xs" />
                  Analysis
                </app-bronco-button>
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
            <app-bronco-button variant="ghost" size="sm" (click)="toggleEvent(event.id)">
              <app-icon [name]="expandedEvents[event.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
              Probe Data
            </app-bronco-button>
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
          }

          @if (event.content) {
            @if (event.eventType === 'SYSTEM_NOTE' && isJsonContent(event.content)) {
              <div class="probe-data-section">
                <app-bronco-button variant="ghost" size="sm" (click)="toggleEvent(event.id)">
                  <app-icon [name]="expandedEvents[event.id] ? 'chevron-up' : 'chevron-down'" size="xs" />
                  {{ expandedEvents[event.id] ? 'Hide Probe Data' : 'Show Probe Data' }}
                </app-bronco-button>
                @if (expandedEvents[event.id]) {
                  <pre class="probe-data-code"><code>{{ formatJson(event.content) }}</code></pre>
                }
              </div>
            } @else if (event.eventType === 'AI_RECOMMENDATION' && hasActionsMeta(event)) {
              @if (recSummaryContent(event); as summary) {
                <div class="event-content markdown-content" [class.collapsed]="!expandedEvents[event.id + '-raw'] && summary.length > 300">
                  <div [innerHTML]="summary | markdown"></div>
                </div>
                @if (summary.length > 300) {
                  <app-bronco-button variant="ghost" size="sm" (click)="toggleEvent(event.id + '-raw')">
                    {{ expandedEvents[event.id + '-raw'] ? 'Hide details' : 'Show details' }}
                  </app-bronco-button>
                }
              }
              <div class="recommendation-actions">
                @for (act of getEventActions(event); track $index) {
                  <div class="rec-action-row" [class.rec-resolved]="getActionOutcome(act) !== 'pending_approval'">
                    <div class="rec-action-header" (click)="getActionOutcome(act) !== 'pending_approval' ? toggleEvent(event.id + '-act-' + $index) : null">
                      <app-icon [name]="recActionIconName(act.action)" size="sm" class="rec-icon" />
                      <span class="rec-action-type">{{ formatRecActionType(act.action) }}</span>
                      <span class="rec-status-badge" [ngClass]="'rec-badge-' + getActionOutcome(act)">
                        {{ getActionOutcomeLabel(act) }}
                      </span>
                      @if (getActionOutcome(act) !== 'pending_approval') {
                        <app-icon [name]="expandedEvents[event.id + '-act-' + $index] ? 'chevron-up' : 'chevron-down'" size="xs" class="rec-expand-icon" />
                      }
                    </div>
                    @if (getActionOutcome(act) === 'pending_approval' || expandedEvents[event.id + '-act-' + $index]) {
                      <div class="rec-action-detail">
                        @if (act.value) {
                          <span class="rec-action-value">{{ act.value }}</span>
                        }
                        <span class="rec-action-reason">{{ act.reason }}</span>
                      </div>
                    }
                    @if (getActionOutcome(act) === 'pending_approval') {
                      <div class="rec-action-buttons">
                        <app-bronco-button variant="primary" size="sm" (click)="approveAction.emit(act.pendingActionId!)">Approve</app-bronco-button>
                        <app-bronco-button variant="secondary" size="sm" (click)="dismissAction.emit(act.pendingActionId!)">Dismiss</app-bronco-button>
                      </div>
                    }
                  </div>
                }
              </div>
            } @else if (isMarkdownEvent(event.eventType)) {
              <div class="event-content markdown-content" [class.collapsed]="!expandedEvents[event.id] && event.content.length > 300">
                <div [innerHTML]="event.content | markdown"></div>
              </div>
              @if (event.content.length > 300) {
                <app-bronco-button variant="ghost" size="sm" (click)="toggleEvent(event.id)">
                  {{ expandedEvents[event.id] ? 'Show less' : 'Show more' }}
                </app-bronco-button>
              }
            }
          }

          <!-- Default rendering for all other event types -->
          @else {
            @if (eventQuestion(event); as q) {
              <div class="event-question">
                <span class="question-icon" aria-hidden="true">?</span>
                <span>{{ q }}</span>
              </div>
            }
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
                <app-bronco-button variant="ghost" size="sm" (click)="toggleEvent(event.id)">
                  {{ expandedEvents[event.id] ? 'Show less' : 'Show more' }}
                </app-bronco-button>
              }
            }
          }
        </app-card>
      } @empty {
        <p class="empty">No events match the current filter.</p>
      }
    </div>
  `,
  styleUrl: './ticket-detail-timeline.component.css',
})
export class TicketDetailTimelineComponent {
  events = input.required<TicketEvent[]>();
  pendingActionMap = input<Record<string, string>>({});

  approveAction = output<string>();
  dismissAction = output<string>();

  timelineFilter = signal('');
  timelineSortAsc = signal(true);

  expandedEvents: Record<string, boolean> = {};
  expandedSections: Record<string, boolean> = {};

  filterOptions = [
    { value: '', label: 'All Events' },
    { value: 'COMMENT', label: 'Comments' },
    { value: 'AI_ANALYSIS', label: 'AI Analysis' },
    { value: 'STATUS_CHANGE', label: 'Status Changes' },
    { value: 'EMAIL_INBOUND', label: 'Inbound Emails' },
    { value: 'EMAIL_OUTBOUND', label: 'Outbound Emails' },
    { value: 'CODE_CHANGE', label: 'Code Changes' },
    { value: 'SYSTEM_NOTE', label: 'System Notes' },
  ];

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

  toggleSort(): void {
    this.timelineSortAsc.update(v => !v);
  }

  toggleEvent(key: string): void {
    this.expandedEvents[key] = !this.expandedEvents[key];
  }

  toggleSection(key: string): void {
    this.expandedSections[key] = !this.expandedSections[key];
  }

  isMarkdownEvent(eventType: string): boolean {
    return eventType === 'AI_ANALYSIS' || eventType === 'AI_RECOMMENDATION' || eventType === 'COMMENT';
  }

  recSummaryContent(event: TicketEvent): string {
    if (!event.content) return '';
    const actionPrefixes = /^[-•]\s*(Auto-executed|Pending approval|Skipped):/i;
    const headerPrefixes = /^\*\*(Auto-executed|Pending approval|Skipped):\*\*$/i;
    return event.content
      .split('\n')
      .filter(line => !actionPrefixes.test(line.trim()) && !headerPrefixes.test(line.trim()))
      .join('\n')
      .trim();
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

  eventIconName(type: string): IconName {
    const icons: Record<string, IconName> = {
      COMMENT: 'comment',
      STATUS_CHANGE: 'rotate',
      PRIORITY_CHANGE: 'warning',
      CATEGORY_CHANGE: 'tag',
      AI_ANALYSIS: 'sparkles',
      AI_RECOMMENDATION: 'bolt',
      EMAIL_INBOUND: 'email',
      EMAIL_OUTBOUND: 'arrow-right',
      CODE_CHANGE: 'file',
      SYSTEM_NOTE: 'info',
    };
    return icons[type] ?? 'active';
  }

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

  getActionOutcome(act: { outcome?: string; applied?: boolean; pendingActionId?: string }): string {
    if (act.pendingActionId) {
      const liveStatus = this.pendingActionMap()[act.pendingActionId];
      if (liveStatus === 'approved') return 'approved';
      if (liveStatus === 'dismissed') return 'dismissed';
      if (liveStatus === 'pending') return 'pending_approval';
    }
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

  recActionIconName(action: string): IconName {
    const icons: Record<string, IconName> = {
      set_status: 'rotate',
      set_priority: 'warning',
      set_category: 'tag',
      add_comment: 'comment',
      trigger_code_fix: 'file',
      send_followup_email: 'email',
      escalate_deep_analysis: 'sparkles',
      check_database_health: 'database',
      assign_operator: 'user',
    };
    return icons[action] ?? 'bolt';
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

  eventQuestion(event: TicketEvent): string | null {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta || meta['phase'] !== 'ai_help') return null;
    return (meta['question'] as string) ?? null;
  }

  isAiTriggered(event: TicketEvent): boolean {
    const meta = event.metadata as Record<string, unknown> | null;
    return meta?.['triggeredBy'] === 'ai_recommendation';
  }

  isAgenticAnalysis(event: TicketEvent): boolean {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta || event.eventType !== 'AI_ANALYSIS') return false;
    return meta['phase'] === 'agentic_analysis' || meta['phase'] === 'deep_analysis';
  }

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
}
