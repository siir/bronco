import { Component, effect, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { DatePipe, SlicePipe } from '@angular/common';
import { DetailPanelService, DetailEntityType } from '../core/services/detail-panel.service';
import { TicketService, Ticket } from '../core/services/ticket.service';
import { ClientService, Client } from '../core/services/client.service';
import { ScheduledProbeService, ScheduledProbe } from '../core/services/scheduled-probe.service';
import { SystemStatusService, ComponentStatus, QueueStats } from '../core/services/system-status.service';
import { SystemAnalysisService, SystemAnalysis } from '../core/services/system-analysis.service';
import { IngestionService, IngestionRunDetail } from '../core/services/ingestion.service';
import {
  StatusBadgeComponent,
  PriorityPillComponent,
  CategoryChipComponent,
  TabComponent,
  TabGroupComponent,
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
    SlicePipe,
    RouterLink,
    StatusBadgeComponent,
    PriorityPillComponent,
    CategoryChipComponent,
    TabComponent,
    TabGroupComponent,
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
            <span class="expand-icon">&#x2197;</span>
          </button>
          <button class="panel-btn" (click)="detailPanel.close()" title="Close panel" aria-label="Close panel">
            <span class="close-icon">&times;</span>
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
        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="selectedTab.set($event)">
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
          </app-tab>
          <app-tab label="Events">
            <p class="placeholder-text">Events view coming soon</p>
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
                <span class="field-label">AI Mode</span>
                <span class="field-value">{{ c.aiMode ?? 'Default' }}</span>
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
  `],
})
export class DetailPanelComponent {
  readonly detailPanel = inject(DetailPanelService);
  private readonly router = inject(Router);
  private readonly ticketService = inject(TicketService);
  private readonly clientService = inject(ClientService);
  private readonly probeService = inject(ScheduledProbeService);
  private readonly systemStatusService = inject(SystemStatusService);
  private readonly systemAnalysisService = inject(SystemAnalysisService);
  private readonly ingestionService = inject(IngestionService);

  ticket = signal<Ticket | null>(null);
  client = signal<Client | null>(null);
  probe = signal<ScheduledProbe | null>(null);
  systemComponent = signal<ComponentStatus | null>(null);
  systemQueueStats = signal<QueueStats | null>(null);
  analysis = signal<SystemAnalysis | null>(null);
  job = signal<IngestionRunDetail | null>(null);
  selectedTab = signal(0);
  loading = signal(false);
  error = signal(false);

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

      if (!type || !id) return;
      this.loading.set(true);

      let sub: Subscription | undefined;
      switch (type) {
        case 'ticket':
          sub = this.ticketService.getTicket(id).subscribe({
            next: (t) => { this.ticket.set(t); this.loading.set(false); },
            error: () => { this.error.set(true); this.loading.set(false); },
          });
          break;
        case 'client':
          sub = this.clientService.getClient(id).subscribe({
            next: (c) => { this.client.set(c); this.loading.set(false); },
            error: () => { this.error.set(true); this.loading.set(false); },
          });
          break;
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
