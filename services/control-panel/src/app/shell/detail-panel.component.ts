import { Component, effect, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe, SlicePipe } from '@angular/common';
import { DetailPanelService, DetailEntityType } from '../core/services/detail-panel.service';
import { TicketService, Ticket, TicketEvent, TicketAiUsageLog, UnifiedLogEntry } from '../core/services/ticket.service';
import { ClientService, Client } from '../core/services/client.service';
import { AiUsageService, type AiUsageClientSummary } from '../core/services/ai-usage.service';
import { ScheduledProbeService, ScheduledProbe } from '../core/services/scheduled-probe.service';
import { SystemStatusService, ComponentStatus, QueueStats, SystemStatusResponse } from '../core/services/system-status.service';
import { SystemAnalysisService, SystemAnalysis } from '../core/services/system-analysis.service';
import { IngestionService, IngestionRunDetail } from '../core/services/ingestion.service';
import {
  StatusBadgeComponent,
  PriorityPillComponent,
  CategoryChipComponent,
  TabComponent,
  TabGroupComponent,
  IconComponent,
} from '../shared/components/index.js';

/** Returns the route segments for a given entity type and id. */
function entityRoute(type: DetailEntityType, id: string): string[] {
  switch (type) {
    case 'ticket': return ['/tickets', id];
    case 'client': return ['/clients', id];
    case 'probe': return ['/scheduled-probes', id, 'runs'];
    case 'system': return ['/system-status'];
    case 'analysis': return ['/system-analysis'];
    case 'job': return ['/ingestion-jobs'];
  }
}

const VALID_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const STATUS_MAP: Record<string, 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed'> = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  ANALYZING: 'analyzing',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

@Component({
  selector: 'app-detail-panel',
  standalone: true,
  imports: [
    DatePipe,
    DecimalPipe,
    SlicePipe,
    RouterLink,
    StatusBadgeComponent,
    PriorityPillComponent,
    CategoryChipComponent,
    TabComponent,
    TabGroupComponent,
    IconComponent,
  ],
  template: `
    <aside class="detail-panel">
      <div class="panel-header">
        <div class="panel-title">
          <span class="entity-type">{{ detailPanel.entityType() }}</span>
          @if (ticket(); as t) {
            <span class="entity-subject">{{ t.subject }}</span>
          } @else if (client(); as c) {
            <span class="entity-subject">{{ c.name }}</span>
          } @else if (probe(); as p) {
            <span class="entity-subject">{{ p.name }}</span>
          } @else if (systemComponent(); as sc) {
            <span class="entity-subject">{{ sc.name }}</span>
          } @else if (analysis(); as a) {
            <span class="entity-subject">Analysis #{{ a.id | slice:0:8 }}</span>
          } @else if (job(); as j) {
            <span class="entity-subject">{{ j.source }} run</span>
          } @else {
            <span class="entity-id">{{ detailPanel.entityId() }}</span>
          }
        </div>
        <div class="panel-actions">
          <button class="panel-btn" (click)="expandToFullPage()" title="Open full page" aria-label="Open full page">
            <app-icon name="external-link" size="sm" />
          </button>
          <button class="panel-btn" (click)="detailPanel.close()" title="Close panel" aria-label="Close panel">
            <app-icon name="close" size="sm" />
          </button>
        </div>
      </div>

      @if (loading()) {
        <div class="panel-loading">Loading...</div>

      } @else if (error()) {
        <div class="panel-loading">Failed to load {{ detailPanel.entityType() }} details.</div>

      <!-- TICKET -->
      } @else if (ticket(); as t) {
        <div class="panel-meta">
          <app-status-badge [status]="mapStatus(t.status)" />
          <app-priority-pill [priority]="mapPriority(t.priority)" />
          @if (t.category) {
            <app-category-chip [category]="t.category" />
          }
        </div>

        @if (detailPanel.mode() === 'full') {
        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">
          <app-tab label="Details">
            <div class="detail-fields">
              <div class="field-row">
                <span class="field-label">Client</span>
                <span class="field-value">
                  @if (t.client; as c) {
                    @if (c.shortCode) {
                      <span class="client-code">{{ c.shortCode }}</span>
                    }
                  }
                  {{ t.client?.name ?? '—' }}
                </span>
              </div>
              <div class="field-row">
                <span class="field-label">System</span>
                <span class="field-value">{{ t.system?.name ?? '—' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Source</span>
                <span class="field-value">{{ t.source }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Created</span>
                <span class="field-value">{{ t.createdAt | date:'medium' }}</span>
              </div>
              @if (t.resolvedAt) {
                <div class="field-row">
                  <span class="field-label">Resolved</span>
                  <span class="field-value">{{ t.resolvedAt | date:'medium' }}</span>
                </div>
              }
            </div>
            @if (t.summary) {
              <div class="detail-section">
                <span class="section-label">Summary</span>
                <p class="summary-text">{{ t.summary }}</p>
              </div>
            }

            <!-- AI Analysis Cards -->
            @if (aiUsageLogs().length) {
              <div class="detail-section">
                <span class="section-label">AI Analysis</span>
                @for (log of aiUsageLogs(); track log.id) {
                  <div class="ai-card">
                    <div class="ai-card-header">
                      <span class="ai-badge">{{ log.taskType }}</span>
                      <span class="ai-model">{{ log.provider }}/{{ log.model }} · {{ log.inputTokens + log.outputTokens }} tokens · {{ formatDuration(log.durationMs) }}</span>
                    </div>
                    @if (log.costUsd != null) {
                      <div class="ai-card-cost">{{ formatCost(log.costUsd) }}</div>
                    }
                  </div>
                }
              </div>
            }

            <!-- Services Health Grid -->
            @if (serviceComponents().length) {
              <div class="detail-section">
                <span class="section-label">Services</span>
                <div class="service-grid">
                  @for (comp of serviceComponents(); track comp.name) {
                    <div class="service-item">
                      <span class="service-dot" [class]="'dot-' + comp.status.toLowerCase()"></span>
                      {{ comp.name }}
                    </div>
                  }
                </div>
              </div>
            }
          </app-tab>
          <app-tab label="Events">
            @if (ticketEvents().length) {
              @for (event of ticketEvents(); track event.id) {
                <div class="event-item" [class]="'event-border-' + eventColorClass(event.eventType)">
                  <div class="event-header">
                    <span class="event-type">{{ formatEventType(event.eventType) }}</span>
                    <span class="event-time">{{ event.createdAt | date:'short' }}</span>
                  </div>
                  @if (event.content) {
                    <div class="event-content">{{ event.content }}</div>
                  }
                  <div class="event-actor">{{ event.actor }}</div>
                </div>
              }
            } @else {
              <p class="placeholder-text">No events</p>
            }
          </app-tab>
          <app-tab label="Logs">
            @if (logsLoading()) {
              <p class="placeholder-text">Loading logs...</p>
            } @else if (unifiedLogs().length) {
              @for (entry of unifiedLogs(); track entry.id) {
                <div class="log-entry" [class]="'log-' + entry.type">
                  <span class="log-time">{{ entry.timestamp | date:'shortTime' }}</span>
                  <span class="log-type-badge">{{ entry.type }}</span>
                  @if (entry.type === 'ai') {
                    <span class="log-detail">{{ entry.taskType }} · {{ entry.model }}</span>
                  } @else {
                    <span class="log-detail">{{ entry.message ?? entry.taskType ?? '—' }}</span>
                  }
                </div>
              }
            } @else {
              <p class="placeholder-text">No logs</p>
            }
          </app-tab>
          <app-tab label="AI Calls">
            @if (aiCallsLoading()) {
              <p class="placeholder-text">Loading AI calls...</p>
            } @else if (aiCallLogs().length) {
              @for (log of aiCallLogs(); track log.id) {
                <div class="ai-call-card">
                  <div class="ai-call-header">
                    <span class="ai-badge">{{ log.taskType }}</span>
                    <span class="ai-call-time">{{ log.createdAt | date:'short' }}</span>
                  </div>
                  <div class="ai-call-meta">
                    <span>{{ log.provider }}/{{ log.model }}</span>
                    <span>{{ log.inputTokens + log.outputTokens }} tokens</span>
                    <span>{{ formatDuration(log.durationMs) }}</span>
                    @if (log.costUsd != null) {
                      <span>{{ formatCost(log.costUsd) }}</span>
                    }
                  </div>
                </div>
              }
            } @else {
              <p class="placeholder-text">No AI calls</p>
            }
          </app-tab>
        </app-tab-group>
        } @else {
        <div class="panel-body">
          <div class="detail-fields">
            <div class="field-row">
              <span class="field-label">Client</span>
              <span class="field-value">
                @if (t.client; as c) {
                  @if (c.shortCode) {
                    <span class="client-code">{{ c.shortCode }}</span>
                  }
                }
                {{ t.client?.name ?? '—' }}
              </span>
            </div>
            <div class="field-row">
              <span class="field-label">System</span>
              <span class="field-value">{{ t.system?.name ?? '—' }}</span>
            </div>
            <div class="field-row">
              <span class="field-label">Source</span>
              <span class="field-value">{{ t.source }}</span>
            </div>
            <div class="field-row">
              <span class="field-label">Created</span>
              <span class="field-value">{{ t.createdAt | date:'medium' }}</span>
            </div>
          </div>
          @if (t.summary) {
            <div class="detail-section">
              <span class="section-label">Summary</span>
              <p class="summary-text">{{ t.summary }}</p>
            </div>
          }
          <div class="compact-footer">
            <a class="view-full-link" [routerLink]="['/tickets', t.id]" (click)="detailPanel.dismiss()">View Full Details</a>
          </div>
        </div>
        }

      <!-- CLIENT -->
      } @else if (client(); as c) {
        <div class="panel-meta">
          @if (c.isActive) {
            <span class="meta-badge meta-success">Active</span>
          } @else {
            <span class="meta-badge meta-muted">Inactive</span>
          }
          <span class="meta-badge meta-accent">{{ c.shortCode }}</span>
        </div>

        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="selectedTab.set($event)">
          <app-tab label="Details">
            <div class="detail-fields">
              <div class="field-row">
                <span class="field-label">Short Code</span>
                <span class="field-value client-code">{{ c.shortCode }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Systems</span>
                <span class="field-value">{{ c._count?.systems ?? 0 }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Tickets</span>
                <span class="field-value">{{ c._count?.tickets ?? 0 }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Repos</span>
                <span class="field-value">{{ c._count?.codeRepos ?? 0 }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Integrations</span>
                <span class="field-value">{{ c._count?.integrations ?? 0 }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Memory</span>
                <span class="field-value">{{ c._count?.clientMemories ?? 0 }} entries</span>
              </div>
              <div class="field-row">
                <span class="field-label">Environments</span>
                <span class="field-value">{{ c._count?.environments ?? 0 }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">People</span>
                <span class="field-value">{{ c._count?.people ?? 0 }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Invoices</span>
                <span class="field-value">{{ c._count?.invoices ?? 0 }}@if (c.invoicedTotalUsd) { &middot; {{ '$' + (c.invoicedTotalUsd | number:'1.2-2') }} }</span>
              </div>
              <div class="field-row">
                <span class="field-label">AI Mode</span>
                <span class="field-value">{{ c.aiMode }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Auto Route</span>
                <span class="field-value">{{ c.autoRouteTickets ? 'Yes' : 'No' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Created</span>
                <span class="field-value">{{ c.createdAt | date:'medium' }}</span>
              </div>
            </div>
            @if (c.notes) {
              <div class="detail-section">
                <span class="section-label">Notes</span>
                <p class="summary-text">{{ c.notes }}</p>
              </div>
            }
          </app-tab>
          <app-tab label="Systems">
            @if (c.systems?.length) {
              @for (sys of c.systems; track sys.id) {
                <div class="list-item">
                  <span class="list-item-name">{{ sys.name }}</span>
                </div>
              }
            } @else {
              <p class="placeholder-text">No systems</p>
            }
          </app-tab>
          <app-tab label="AI Usage">
            @if (clientAiUsage(); as usage) {
              <div class="usage-grid">
                @for (w of usage.windows; track w.label) {
                  <div class="usage-card">
                    <span class="usage-window">{{ w.label }}</span>
                    <span class="usage-cost">{{ '$' + (w.billedCostUsd | number:'1.2-2') }}</span>
                    <span class="usage-detail">{{ w.requestCount | number }} calls</span>
                    <span class="usage-detail">{{ w.totalTokens | number }} tokens</span>
                  </div>
                }
              </div>
              @if (usage.billingMarkupPercent > 1) {
                <p class="usage-note">Markup: {{ ((usage.billingMarkupPercent - 1) * 100) | number:'1.0-0' }}%</p>
              }
            } @else {
              <p class="placeholder-text">Loading usage data...</p>
            }
          </app-tab>
        </app-tab-group>

      <!-- PROBE -->
      } @else if (probe(); as p) {
        <div class="panel-meta">
          @if (p.isActive) {
            <span class="meta-badge meta-success">Active</span>
          } @else {
            <span class="meta-badge meta-muted">Inactive</span>
          }
          <span class="meta-badge meta-accent">{{ p.action }}</span>
        </div>

        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="selectedTab.set($event)">
          <app-tab label="Details">
            <div class="detail-fields">
              <div class="field-row">
                <span class="field-label">Tool</span>
                <span class="field-value" style="font-family: ui-monospace, monospace; font-size: 12px;">{{ p.toolName }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Client</span>
                <span class="field-value">
                  @if (p.client; as pc) {
                    @if (pc.shortCode) {
                      <span class="client-code">{{ pc.shortCode }}</span>
                    }
                    {{ pc.name }}
                  } @else {
                    —
                  }
                </span>
              </div>
              <div class="field-row">
                <span class="field-label">Schedule</span>
                <span class="field-value">{{ p.cronExpression }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Category</span>
                <span class="field-value">{{ p.category ?? 'Any' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Retention</span>
                <span class="field-value">{{ p.retentionDays }}d / {{ p.retentionMaxRuns }} runs</span>
              </div>
            </div>
            @if (p.description) {
              <div class="detail-section">
                <span class="section-label">Description</span>
                <p class="summary-text">{{ p.description }}</p>
              </div>
            }
          </app-tab>
          <app-tab label="Last Run">
            @if (p.lastRunAt) {
              <div class="detail-fields">
                <div class="field-row">
                  <span class="field-label">Status</span>
                  <span class="field-value">
                    <span [class]="'run-status' + (p.lastRunStatus ? ' run-' + p.lastRunStatus : '')">{{ p.lastRunStatus ?? '—' }}</span>
                  </span>
                </div>
                <div class="field-row">
                  <span class="field-label">Time</span>
                  <span class="field-value">{{ p.lastRunAt | date:'medium' }}</span>
                </div>
              </div>
              @if (p.lastRunResult) {
                <div class="detail-section">
                  <span class="section-label">Result</span>
                  <pre class="result-block">{{ p.lastRunResult | slice:0:500 }}</pre>
                </div>
              }
            } @else {
              <p class="placeholder-text">No runs yet</p>
            }
          </app-tab>
        </app-tab-group>

      <!-- SYSTEM -->
      } @else if (systemComponent(); as sc) {
        <div class="panel-meta">
          <span class="meta-badge" [class]="systemStatusClass(sc.status)">{{ sc.status }}</span>
          <span class="meta-badge meta-muted">{{ sc.type }}</span>
        </div>

        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="selectedTab.set($event)">
          <app-tab label="Details">
            <div class="detail-fields">
              <div class="field-row">
                <span class="field-label">Name</span>
                <span class="field-value">{{ sc.name }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Type</span>
                <span class="field-value">{{ sc.type }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Status</span>
                <span class="field-value">{{ sc.status }}</span>
              </div>
              @if (sc.endpoint) {
                <div class="field-row">
                  <span class="field-label">Endpoint</span>
                  <span class="field-value" style="font-family: ui-monospace, monospace; font-size: 12px;">{{ sc.endpoint }}</span>
                </div>
              }
              @if (sc.latencyMs != null) {
                <div class="field-row">
                  <span class="field-label">Latency</span>
                  <span class="field-value">{{ sc.latencyMs }}ms</span>
                </div>
              }
              @if (sc.uptime) {
                <div class="field-row">
                  <span class="field-label">Uptime</span>
                  <span class="field-value">{{ sc.uptime }}</span>
                </div>
              }
              <div class="field-row">
                <span class="field-label">Controllable</span>
                <span class="field-value">{{ sc.controllable ? 'Yes' : 'No' }}</span>
              </div>
            </div>
          </app-tab>
          <app-tab label="Queue Stats">
            @if (systemQueueStats(); as qs) {
              <div class="detail-fields">
                <div class="field-row">
                  <span class="field-label">Waiting</span>
                  <span class="field-value">{{ qs.waiting }}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">Active</span>
                  <span class="field-value">{{ qs.active }}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">Completed</span>
                  <span class="field-value">{{ qs.completed }}</span>
                </div>
                <div class="field-row">
                  <span class="field-label">Failed</span>
                  <span class="field-value">{{ qs.failed }}</span>
                </div>
              </div>
            } @else {
              <p class="placeholder-text">No queue data</p>
            }
          </app-tab>
        </app-tab-group>

      <!-- ANALYSIS -->
      } @else if (analysis(); as a) {
        <div class="panel-meta">
          <span class="meta-badge" [class]="analysisStatusClass(a.status)">{{ a.status }}</span>
        </div>

        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="selectedTab.set($event)">
          <app-tab label="Details">
            <div class="detail-fields">
              <div class="field-row">
                <span class="field-label">Client ID</span>
                <span class="field-value">{{ a.clientId }}</span>
              </div>
              @if (a.ticketId) {
                <div class="field-row">
                  <span class="field-label">Ticket ID</span>
                  <span class="field-value">{{ a.ticketId }}</span>
                </div>
              }
              <div class="field-row">
                <span class="field-label">AI Model</span>
                <span class="field-value">{{ a.aiModel ?? '—' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">AI Provider</span>
                <span class="field-value">{{ a.aiProvider ?? '—' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Created</span>
                <span class="field-value">{{ a.createdAt | date:'medium' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Updated</span>
                <span class="field-value">{{ a.updatedAt | date:'medium' }}</span>
              </div>
            </div>
          </app-tab>
          <app-tab label="Analysis">
            @if (a.analysis) {
              <div class="detail-section">
                <p class="summary-text analysis-preformatted">{{ a.analysis }}</p>
              </div>
            } @else {
              <p class="placeholder-text">No analysis text</p>
            }
          </app-tab>
          <app-tab label="Suggestions">
            @if (a.suggestions) {
              <div class="detail-section">
                <p class="summary-text analysis-preformatted">{{ a.suggestions }}</p>
              </div>
            } @else {
              <p class="placeholder-text">No suggestions</p>
            }
            @if (a.status === 'REJECTED' && a.rejectionReason) {
              <div class="rejection-card">
                <span class="section-label">Rejection Reason</span>
                <p class="summary-text">{{ a.rejectionReason }}</p>
              </div>
            }
          </app-tab>
        </app-tab-group>

      <!-- JOB / INGESTION -->
      } @else if (job(); as j) {
        <div class="panel-meta">
          <span class="meta-badge" [class]="jobStatusClass(j.status)">{{ j.status }}</span>
          <span class="meta-badge meta-muted">{{ j.source }}</span>
        </div>

        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="selectedTab.set($event)">
          <app-tab label="Details">
            <div class="detail-fields">
              <div class="field-row">
                <span class="field-label">Source</span>
                <span class="field-value">{{ j.source }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Client</span>
                <span class="field-value">
                  <span class="client-code">{{ j.client.shortCode }}</span>
                  {{ j.client.name }}
                </span>
              </div>
              <div class="field-row">
                <span class="field-label">Route</span>
                <span class="field-value">{{ j.routeName ?? '—' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Status</span>
                <span class="field-value">{{ j.status }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Started</span>
                <span class="field-value">{{ j.startedAt | date:'medium' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Completed</span>
                <span class="field-value">{{ j.completedAt ? (j.completedAt | date:'medium') : 'Running...' }}</span>
              </div>
              @if (j.ticketId) {
                <div class="field-row">
                  <span class="field-label">Ticket ID</span>
                  <span class="field-value">{{ j.ticketId }}</span>
                </div>
              }
            </div>
          </app-tab>
          <app-tab label="Steps">
            @if (j.steps.length) {
              @for (step of j.steps; track step.id) {
                <div class="list-item step-item">
                  <div class="step-header">
                    <span class="list-item-name">{{ step.stepOrder }}. {{ step.stepName }}</span>
                    <span class="meta-badge step-badge" [class]="stepStatusClass(step.status)">{{ step.status }}</span>
                  </div>
                  @if (step.durationMs != null) {
                    <span class="step-duration">{{ step.durationMs }}ms</span>
                  }
                  @if (step.error) {
                    <p class="step-error">{{ step.error }}</p>
                  }
                </div>
              }
            } @else {
              <p class="placeholder-text">No steps</p>
            }
          </app-tab>
        </app-tab-group>

      } @else {
        <div class="panel-body">
          <p class="placeholder-text">
            Detail panel content for {{ detailPanel.entityType() }} {{ detailPanel.entityId() }}
          </p>
        </div>
      }
    </aside>
  `,
  styles: [`
    .detail-panel {
      width: var(--detail-panel-width);
      min-width: var(--detail-panel-width);
      height: 100vh;
      background: var(--bg-panel);
      border-left: 1px solid var(--border-light);
      display: flex;
      flex-direction: column;
      font-family: var(--font-primary);
      animation: slide-in 200ms ease;
    }
    @keyframes slide-in {
      from {
        width: 0;
        min-width: 0;
        opacity: 0;
      }
      to {
        width: var(--detail-panel-width);
        min-width: var(--detail-panel-width);
        opacity: 1;
      }
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-light);
      min-height: var(--header-height);
    }
    .panel-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .entity-type {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
    }
    .entity-id {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }
    .entity-subject {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      line-height: 1.3;
    }
    .panel-actions {
      display: flex;
      gap: 4px;
    }
    .panel-btn {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-tertiary);
      font-size: 16px;
      transition: background 120ms ease;
    }
    .panel-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
    .expand-icon {
      font-size: 14px;
    }
    .close-icon {
      font-size: 20px;
      line-height: 1;
    }
    .panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
    }
    .placeholder-text {
      font-size: 13px;
      color: var(--text-tertiary);
    }

    .panel-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-light);
      align-items: center;
    }

    .panel-loading {
      padding: 48px 20px;
      text-align: center;
      font-size: 13px;
      color: var(--text-tertiary);
    }

    .detail-fields {
      padding: 4px 0;
    }

    .field-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
    }

    .field-label {
      font-size: 13px;
      color: var(--text-tertiary);
    }

    .field-value {
      font-size: 13px;
      color: var(--text-primary);
      font-weight: 500;
    }

    .client-code {
      color: var(--accent);
      font-weight: 600;
    }

    .detail-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
    }

    .section-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }

    .summary-text {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
      margin: 0;
    }

    .meta-badge {
      font-size: 12px;
      font-weight: 500;
      padding: 2px 10px;
      border-radius: var(--radius-pill);
    }

    .meta-success {
      background: rgba(52,199,89,0.08);
      color: var(--color-success);
    }

    .meta-muted {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }

    .meta-accent {
      background: var(--bg-active);
      color: var(--accent);
      font-family: ui-monospace, monospace;
    }

    .list-item {
      padding: 8px 0;
      border-bottom: 1px solid var(--border-light);
      font-size: 13px;
      color: var(--text-secondary);
    }

    .list-item:last-child {
      border-bottom: none;
    }

    .list-item-name {
      font-weight: 500;
      color: var(--text-primary);
    }

    .run-status {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
    }

    .run-success {
      background: rgba(52,199,89,0.08);
      color: var(--color-success);
    }

    .run-error {
      background: rgba(255,59,48,0.08);
      color: var(--color-error);
    }

    .run-skipped {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }

    .compact-footer {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
    }

    .view-full-link {
      display: inline-block;
      font-size: 13px;
      font-weight: 500;
      color: var(--accent);
      text-decoration: none;
      cursor: pointer;
    }

    .view-full-link:hover {
      text-decoration: underline;
    }

    .result-block {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      background: var(--bg-muted);
      border-radius: var(--radius-md);
      padding: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
      color: var(--text-secondary);
      margin: 0;
    }

    app-tab-group {
      flex: 1;
      overflow-y: auto;
    }
    app-tab-group .detail-fields,
    app-tab-group .detail-section,
    app-tab-group .placeholder-text {
      padding-left: 20px;
      padding-right: 20px;
    }
    .usage-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 12px 20px;
    }
    .usage-card {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 12px;
      background: var(--bg-page);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-light);
    }
    .usage-window {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .usage-cost {
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .usage-detail {
      font-size: 11px;
      color: var(--text-tertiary);
    }
    .usage-note {
      font-size: 11px;
      color: var(--text-tertiary);
      padding: 4px 20px 8px;
      margin: 0;
    }
    app-tab-group .list-item {
      padding-left: 20px;
      padding-right: 20px;
    }
    app-tab-group .summary-text {
      padding-left: 20px;
      padding-right: 20px;
    }

    .meta-info {
      background: var(--color-info-subtle, rgba(0,122,255,0.08));
      color: var(--color-info, #007aff);
    }
    .meta-error {
      background: rgba(255,59,48,0.08);
      color: var(--color-error);
    }
    .meta-warning {
      background: rgba(255,149,0,0.08);
      color: var(--color-warning, #ff9500);
    }

    .analysis-preformatted {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .rejection-card {
      margin: 12px 20px;
      padding: 12px;
      background: rgba(255,59,48,0.04);
      border: 1px solid rgba(255,59,48,0.12);
      border-radius: var(--radius-md);
    }

    .step-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .step-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .step-badge {
      font-size: 10px;
      padding: 1px 6px;
    }
    .step-duration {
      font-size: 12px;
      color: var(--text-tertiary);
      font-family: ui-monospace, monospace;
    }
    .step-error {
      font-size: 12px;
      color: var(--color-error);
      margin: 2px 0 0;
      line-height: 1.4;
    }

    /* AI Analysis Cards */
    .ai-card {
      background: var(--bg-muted);
      border-radius: var(--radius-lg);
      padding: 14px;
      margin-top: 10px;
    }
    .ai-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .ai-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-pill);
      background: var(--bg-active);
      color: var(--accent);
      white-space: nowrap;
    }
    .ai-model {
      font-size: 11px;
      color: var(--text-tertiary);
      font-weight: 400;
    }
    .ai-card-cost {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-top: 2px;
    }

    /* Services Health Grid */
    .service-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
      margin-top: 10px;
    }
    .service-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: var(--bg-muted);
      border-radius: var(--radius-md);
      font-size: 12px;
      color: var(--text-secondary);
    }
    .service-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot-up { background: var(--color-success); }
    .dot-down { background: var(--color-error); }
    .dot-degraded { background: var(--color-warning, #ff9500); }
    .dot-unknown { background: var(--text-tertiary); }

    /* Events Timeline */
    .event-item {
      padding: 10px 20px;
      border-left: 3px solid var(--border-light);
      font-size: 13px;
    }
    .event-item + .event-item {
      border-top: 1px solid var(--border-light);
    }
    .event-border-blue { border-left-color: var(--accent); }
    .event-border-green { border-left-color: var(--color-success); }
    .event-border-orange { border-left-color: var(--color-warning, #ff9500); }
    .event-border-red { border-left-color: var(--color-error); }
    .event-border-purple { border-left-color: #af52de; }
    .event-border-gray { border-left-color: var(--text-tertiary); }
    .event-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .event-type {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .event-time {
      font-size: 11px;
      color: var(--text-tertiary);
      white-space: nowrap;
    }
    .event-content {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
      margin-bottom: 4px;
    }
    .event-actor {
      font-size: 11px;
      color: var(--text-tertiary);
    }

    /* Logs */
    .log-entry {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 20px;
      font-size: 12px;
      border-bottom: 1px solid var(--border-light);
    }
    .log-entry:last-child { border-bottom: none; }
    .log-time {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: var(--text-tertiary);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .log-type-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      background: var(--bg-muted);
      color: var(--text-tertiary);
      text-transform: uppercase;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .log-ai .log-type-badge { background: var(--bg-active); color: var(--accent); }
    .log-error .log-type-badge { background: rgba(255,59,48,0.08); color: var(--color-error); }
    .log-detail {
      font-size: 12px;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* AI Calls tab */
    .ai-call-card {
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-light);
    }
    .ai-call-card:last-child { border-bottom: none; }
    .ai-call-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .ai-call-time {
      font-size: 11px;
      color: var(--text-tertiary);
    }
    .ai-call-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 12px;
      color: var(--text-tertiary);
    }
  `],
})
export class DetailPanelComponent {
  readonly detailPanel = inject(DetailPanelService);
  private readonly router = inject(Router);
  private readonly ticketService = inject(TicketService);
  private readonly clientService = inject(ClientService);
  private readonly aiUsageService = inject(AiUsageService);
  private readonly probeService = inject(ScheduledProbeService);
  private readonly systemStatusService = inject(SystemStatusService);
  private readonly systemAnalysisService = inject(SystemAnalysisService);
  private readonly ingestionService = inject(IngestionService);

  ticket = signal<Ticket | null>(null);
  client = signal<Client | null>(null);
  clientAiUsage = signal<AiUsageClientSummary | null>(null);
  probe = signal<ScheduledProbe | null>(null);
  systemComponent = signal<ComponentStatus | null>(null);
  systemQueueStats = signal<QueueStats | null>(null);
  analysis = signal<SystemAnalysis | null>(null);
  job = signal<IngestionRunDetail | null>(null);
  selectedTab = signal(0);
  loading = signal(false);
  error = signal(false);

  // Ticket enrichment signals
  ticketEvents = signal<TicketEvent[]>([]);
  aiUsageLogs = signal<TicketAiUsageLog[]>([]);
  serviceComponents = signal<ComponentStatus[]>([]);
  unifiedLogs = signal<UnifiedLogEntry[]>([]);
  logsLoading = signal(false);
  aiCallLogs = signal<TicketAiUsageLog[]>([]);
  aiCallsLoading = signal(false);

  // Cache for system status (shared across tickets)
  private cachedSystemStatus: SystemStatusResponse | null = null;
  private logsLoaded = false;
  private aiCallsLoaded = false;

  constructor() {
    effect((onCleanup) => {
      const type = this.detailPanel.entityType();
      const id = this.detailPanel.entityId();
      // Reset all
      this.ticket.set(null);
      this.client.set(null);
      this.probe.set(null);
      this.systemComponent.set(null);
      this.systemQueueStats.set(null);
      this.analysis.set(null);
      this.job.set(null);
      this.error.set(false);
      this.selectedTab.set(0);
      this.ticketEvents.set([]);
      this.aiUsageLogs.set([]);
      this.unifiedLogs.set([]);
      this.aiCallLogs.set([]);
      this.logsLoaded = false;
      this.aiCallsLoaded = false;

      if (!type || !id) return;
      this.loading.set(true);

      let sub: Subscription | undefined;
      switch (type) {
        case 'ticket': {
          const subs: Subscription[] = [];
          subs.push(this.ticketService.getTicket(id).subscribe({
            next: (t) => {
              this.ticket.set(t);
              this.ticketEvents.set(t.events ?? []);
              this.loading.set(false);
            },
            error: () => { this.error.set(true); this.loading.set(false); },
          }));
          // Load AI usage for Details tab cards
          subs.push(this.ticketService.getTicketAiUsage(id, { limit: 5 }).subscribe({
            next: (res) => this.aiUsageLogs.set(res.logs),
          }));
          // Load services status (cached)
          if (this.cachedSystemStatus) {
            this.serviceComponents.set(this.cachedSystemStatus.components ?? []);
          } else {
            subs.push(this.systemStatusService.getStatus().subscribe({
              next: (res) => {
                this.cachedSystemStatus = res;
                this.serviceComponents.set(res.components ?? []);
              },
            }));
          }
          sub = { unsubscribe: () => subs.forEach(s => s.unsubscribe()) } as Subscription;
          break;
        }
        case 'client': {
          const clientSub = this.clientService.getClient(id).subscribe({
            next: (c) => { this.client.set(c); this.loading.set(false); },
            error: () => { this.error.set(true); this.loading.set(false); },
          });
          const usageSub = this.aiUsageService.getClientSummary(id).subscribe({
            next: (s) => this.clientAiUsage.set(s),
          });
          sub = { unsubscribe: () => { clientSub.unsubscribe(); usageSub.unsubscribe(); } } as Subscription;
          break;
        }
        case 'probe':
          sub = this.probeService.getProbe(id).subscribe({
            next: (p) => { this.probe.set(p); this.loading.set(false); },
            error: () => { this.error.set(true); this.loading.set(false); },
          });
          break;
        case 'system':
          sub = this.systemStatusService.getStatus().subscribe({
            next: (res) => {
              const all = [
                ...(res.components ?? []),
                ...(res.llmProviders ?? []),
              ];
              const match = all.find(c => c.name === id);
              this.systemComponent.set(match ?? null);
              this.systemQueueStats.set(res.queueStats?.[id] ?? null);
              if (!match) this.error.set(true);
              this.loading.set(false);
            },
            error: () => { this.error.set(true); this.loading.set(false); },
          });
          break;
        case 'analysis':
          sub = this.systemAnalysisService.getAnalysis(id).subscribe({
            next: (a) => { this.analysis.set(a); this.loading.set(false); },
            error: () => { this.error.set(true); this.loading.set(false); },
          });
          break;
        case 'job':
          sub = this.ingestionService.getRun(id).subscribe({
            next: (j) => { this.job.set(j); this.loading.set(false); },
            error: () => { this.error.set(true); this.loading.set(false); },
          });
          break;
        default:
          this.loading.set(false);
      }
      onCleanup(() => sub?.unsubscribe());
    });
  }

  expandToFullPage(): void {
    const type = this.detailPanel.entityType();
    const id = this.detailPanel.entityId();
    if (type && id) {
      this.detailPanel.close();
      this.router.navigate(entityRoute(type, id));
    }
  }

  /** Handle tab changes — lazy-load Logs and AI Calls data */
  onTabChange(index: number): void {
    this.selectedTab.set(index);
    const t = this.ticket();
    if (!t) return;

    // Logs tab (index 2 in the ticket full-mode tab group)
    if (index === 2 && !this.logsLoaded) {
      this.logsLoaded = true;
      this.logsLoading.set(true);
      this.ticketService.getUnifiedLogs(t.id, { limit: 20 }).subscribe({
        next: (res) => { this.unifiedLogs.set(res.entries); this.logsLoading.set(false); },
        error: () => this.logsLoading.set(false),
      });
    }

    // AI Calls tab (index 3)
    if (index === 3 && !this.aiCallsLoaded) {
      this.aiCallsLoaded = true;
      this.aiCallsLoading.set(true);
      this.ticketService.getTicketAiUsage(t.id, { limit: 10 }).subscribe({
        next: (res) => { this.aiCallLogs.set(res.logs); this.aiCallsLoading.set(false); },
        error: () => this.aiCallsLoading.set(false),
      });
    }
  }

  formatCost(costUsd: number | null): string {
    if (costUsd == null) return '—';
    return '$' + costUsd.toFixed(4);
  }

  formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  formatEventType(eventType: string): string {
    return eventType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  eventColorClass(eventType: string): string {
    switch (eventType) {
      case 'AI_ANALYSIS':
      case 'AI_RECOMMENDATION': return 'purple';
      case 'STATUS_CHANGE': return 'blue';
      case 'EMAIL_INBOUND': return 'green';
      case 'EMAIL_OUTBOUND': return 'green';
      case 'CODE_CHANGE': return 'orange';
      case 'COMMENT': return 'blue';
      default: return 'gray';
    }
  }

  mapPriority(priority: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
    return VALID_PRIORITIES.has(priority) ? priority as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' : 'MEDIUM';
  }

  /** Map API ticket status strings to StatusBadge values */
  mapStatus(status: string): 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed' {
    return STATUS_MAP[status] ?? 'open';
  }

  systemStatusClass(status: string): string {
    switch (status) {
      case 'UP': return 'meta-badge meta-success';
      case 'DOWN': return 'meta-badge meta-error';
      case 'DEGRADED': return 'meta-badge meta-warning';
      default: return 'meta-badge meta-muted';
    }
  }

  analysisStatusClass(status: string): string {
    switch (status) {
      case 'PENDING': return 'meta-badge meta-info';
      case 'ACKNOWLEDGED': return 'meta-badge meta-success';
      case 'REJECTED': return 'meta-badge meta-error';
      default: return 'meta-badge meta-muted';
    }
  }

  private ingestionStatusTone(status: string): 'meta-success' | 'meta-error' | 'meta-info' | 'meta-muted' {
    const s = status.trim().toUpperCase();
    if (s === 'COMPLETED' || s === 'SUCCESS' || s === 'SUCCEEDED' || s === 'DONE') return 'meta-success';
    if (s === 'FAILED' || s === 'ERROR') return 'meta-error';
    if (s === 'RUNNING' || s === 'PROCESSING' || s === 'IN_PROGRESS') return 'meta-info';
    return 'meta-muted';
  }

  jobStatusClass(status: string): string {
    return `meta-badge ${this.ingestionStatusTone(status)}`;
  }

  stepStatusClass(status: string): string {
    return this.ingestionStatusTone(status);
  }

}
