import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatMenuModule } from '@angular/material/menu';
import { RouterLink } from '@angular/router';
import type { Subscription } from 'rxjs';
import {
  SystemStatusService,
  SystemStatusResponse,
  QueueStats,
  McpServerStatus,
} from '../../core/services/system-status.service';
import type { McpDiscoveryMetadata } from '../../core/services/integration.service';
import { AiProviderService } from '../../core/services/ai-provider.service';
import { NotificationChannelsComponent } from '../notification-channels/notification-channels.component';
import { McpServerInfoComponent } from '../../shared/components/mcp-server-info.component';

@Component({
  standalone: true,
  imports: [
    RouterLink,
    MatMenuModule,
    NotificationChannelsComponent,
    McpServerInfoComponent,
  ],
  template: `
    <div class="system-status-page">
      <div class="page-header">
        <h1 class="page-title">System Status</h1>
        <div class="header-actions">
          @if (lastRefresh()) {
            <span class="last-refresh">Updated {{ lastRefresh() }}</span>
          }
          <button class="btn-refresh" (click)="refresh()" [disabled]="loading()">&#x21bb; Refresh</button>
        </div>
      </div>

      @if (loading() && !data()) {
        <div class="loading-state">Loading system status...</div>
      }

      @if (data()) {
        <!-- Overall status banner -->
        <div class="overall-status {{ data()!.status.toLowerCase() }}">
          <span class="overall-status-icon">{{ statusIcon(data()!.status) }}</span>
          <div>
            <div class="overall-status-title">System {{ data()!.status === 'UP' ? 'Operational' : data()!.status === 'DEGRADED' ? 'Degraded' : 'Down' }}</div>
            <div class="overall-status-subtitle">{{ upCount() }} of {{ totalMonitored() }} components operational</div>
          </div>
        </div>

        <!-- Config warnings -->
        @if (data()!.configIssues && data()!.configIssues!.length > 0) {
          <div class="warning-banner">
            <div class="warning-banner-header">
              <span class="warning-icon-text">&#x26A0;</span>
              <span class="warning-title">Configuration Issues</span>
            </div>
            <ul class="config-list">
              @for (issue of data()!.configIssues!; track issue) {
                <li>{{ issue }}</li>
              }
            </ul>
          </div>
        }

        <!-- No AI providers warning -->
        @if (noAiProviders()) {
          <div class="warning-banner">
            <div class="warning-banner-content">
              <span class="warning-icon-text">&#x1F9E0;</span>
              <div>
                <div class="warning-title">No LLM providers configured</div>
                <div class="warning-subtitle">AI features are unavailable. <a routerLink="/ai-providers" class="configure-link">Configure providers</a></div>
              </div>
            </div>
          </div>
        }

        <!-- Infrastructure -->
        <h2 class="section-title">Infrastructure</h2>
        <div class="component-grid">
          @for (comp of infrastructure(); track comp.name) {
            <div class="status-card">
              <div class="component-header">
                <div class="component-name">
                  <span class="status-dot {{ comp.status.toLowerCase() }}"></span>
                  {{ comp.name }}
                </div>
                @if (comp.controllable) {
                  <button type="button" class="btn-icon" [matMenuTriggerFor]="menu" [disabled]="controlling() === serviceKey(comp.name)" [attr.aria-label]="'Service controls for ' + comp.name" title="Service controls">
                    @if (controlling() === serviceKey(comp.name)) {
                      <span class="spinner-inline"></span>
                    } @else {
                      &#x22EE;
                    }
                  </button>
                  <mat-menu #menu="matMenu">
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'restart')">
                      &#x21bb; Restart
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'stop')">
                      &#x25A0; Stop
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'start')">
                      &#x25B6; Start
                    </button>
                  </mat-menu>
                }
              </div>

              <div class="component-meta">
                <span class="status-chip {{ comp.status.toLowerCase() }}">{{ comp.status }}</span>
                @if (comp.endpoint) {
                  <span class="endpoint" [title]="comp.endpoint">{{ comp.endpoint }}</span>
                }
              </div>

              @if (comp.latencyMs !== undefined) {
                <div class="metric">
                  <span class="metric-label">Latency</span>
                  <span class="metric-value">{{ comp.latencyMs }}ms</span>
                </div>
              }
              @if (comp.uptime) {
                <div class="metric">
                  <span class="metric-label">Uptime</span>
                  <span class="metric-value">{{ comp.uptime }}</span>
                </div>
              }
              @if (comp.details) {
                @for (entry of detailEntries(comp.details); track entry[0]) {
                  @if (entry[0] !== 'httpStatus' && entry[0] !== 'note' && entry[0] !== 'error') {
                    <div class="metric">
                      <span class="metric-label">{{ formatLabel(entry[0]) }}</span>
                      <span class="metric-value">{{ formatValue(entry[1]) }}</span>
                    </div>
                  }
                }
                @if (comp.details['error']) {
                  <div class="error-detail">{{ comp.details['error'] }}</div>
                }
              }

              @if (comp.configIssues && comp.configIssues.length > 0) {
                @for (issue of comp.configIssues; track issue) {
                  <div class="config-issue">{{ issue }}</div>
                }
              }
            </div>
          }
        </div>

        <!-- Services -->
        <h2 class="section-title">Services</h2>
        <div class="component-grid">
          @for (comp of services(); track comp.name) {
            <div class="status-card">
              <div class="component-header">
                <div class="component-name">
                  <span class="status-dot {{ comp.status.toLowerCase() }}"></span>
                  {{ comp.name }}
                </div>
                @if (comp.controllable) {
                  <button type="button" class="btn-icon" [matMenuTriggerFor]="svcMenu" [disabled]="controlling() === serviceKey(comp.name)" [attr.aria-label]="'Service controls for ' + comp.name" title="Service controls">
                    @if (controlling() === serviceKey(comp.name)) {
                      <span class="spinner-inline"></span>
                    } @else {
                      &#x22EE;
                    }
                  </button>
                  <mat-menu #svcMenu="matMenu">
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'restart')">
                      &#x21bb; Restart
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'stop')">
                      &#x25A0; Stop
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'start')">
                      &#x25B6; Start
                    </button>
                  </mat-menu>
                }
              </div>

              <div class="component-meta">
                <span class="status-chip {{ comp.status.toLowerCase() }}">{{ comp.status }}</span>
                @if (comp.endpoint) {
                  <span class="endpoint">{{ truncateEndpoint(comp.endpoint) }}</span>
                }
              </div>

              @if (comp.latencyMs !== undefined) {
                <div class="metric">
                  <span class="metric-label">Latency</span>
                  <span class="metric-value">{{ comp.latencyMs }}ms</span>
                </div>
              }
              @if (comp.uptime) {
                <div class="metric">
                  <span class="metric-label">Uptime</span>
                  <span class="metric-value">{{ comp.uptime }}</span>
                </div>
              }
              @if (comp.details) {
                @if (comp.details['note']) {
                  <div class="info-note">{{ comp.details['note'] }}</div>
                }
                @for (entry of detailEntries(comp.details); track entry[0]) {
                  @if (!isServiceInternalKey(entry[0])) {
                    <div class="metric">
                      <span class="metric-label">{{ formatLabel(entry[0]) }}</span>
                      <span class="metric-value">{{ formatValue(entry[1]) }}</span>
                    </div>
                  }
                }
                @if (comp.details['error']) {
                  <div class="error-detail">{{ comp.details['error'] }}</div>
                }
              }
            </div>
          }
        </div>

        <!-- External Dependencies -->
        <h2 class="section-title">External Dependencies</h2>
        <div class="component-grid">
          @for (comp of external(); track comp.name) {
            <div class="status-card">
              <div class="component-header">
                <div class="component-name">
                  <span class="status-dot {{ comp.status.toLowerCase() }}"></span>
                  {{ comp.name }}
                </div>
              </div>

              <div class="component-meta">
                <span class="status-chip {{ comp.status.toLowerCase() }}">{{ comp.status }}</span>
                @if (comp.endpoint) {
                  <span class="endpoint" [title]="comp.endpoint">{{ truncateEndpoint(comp.endpoint) }}</span>
                }
              </div>

              @if (comp.latencyMs !== undefined) {
                <div class="metric">
                  <span class="metric-label">Latency</span>
                  <span class="metric-value">{{ comp.latencyMs }}ms</span>
                </div>
              }
              @if (comp.details) {
                @for (entry of detailEntries(comp.details); track entry[0]) {
                  @if (entry[0] !== 'httpStatus' && entry[0] !== 'error') {
                    <div class="metric">
                      <span class="metric-label">{{ formatLabel(entry[0]) }}</span>
                      <span class="metric-value">{{ formatValue(entry[1]) }}</span>
                    </div>
                  }
                }
                @if (comp.details['error']) {
                  <div class="error-detail">{{ comp.details['error'] }}</div>
                }
              }

              @if (comp.configIssues && comp.configIssues.length > 0) {
                @for (issue of comp.configIssues; track issue) {
                  <div class="config-issue">{{ issue }}</div>
                }
              }
            </div>
          }
        </div>

        <!-- LLM Providers -->
        @if (llmProviders().length > 0) {
          <h2 class="section-title">LLM Providers</h2>
          <div class="component-grid">
            @for (llm of llmProviders(); track llm.name) {
              <div class="status-card">
                <div class="component-header">
                  <div class="component-name">
                    <span class="status-dot {{ llm.status.toLowerCase() }}"></span>
                    {{ llm.name.replace('LLM: ', '') }}
                  </div>
                  <span class="llm-badge">LLM</span>
                </div>

                <div class="component-meta">
                  <span class="status-chip {{ llm.status.toLowerCase() }}">{{ llm.status }}</span>
                  @if (llm.endpoint) {
                    <span class="endpoint" [title]="llm.endpoint">{{ truncateEndpoint(llm.endpoint) }}</span>
                  }
                </div>

                @if (llm.latencyMs !== undefined) {
                  <div class="metric">
                    <span class="metric-label">Latency</span>
                    <span class="metric-value">{{ llm.latencyMs }}ms</span>
                  </div>
                }
                @if (llm.details) {
                  @if (llm.details['model']) {
                    <div class="metric">
                      <span class="metric-label">Model</span>
                      <span class="metric-value">{{ llm.details['model'] }}</span>
                    </div>
                  }
                  @if (llm.details['modelsLoaded'] !== undefined) {
                    <div class="metric">
                      <span class="metric-label">Models Loaded</span>
                      <span class="metric-value">{{ llm.details['modelsLoaded'] }}</span>
                    </div>
                  }
                  @for (entry of detailEntries(llm.details); track entry[0]) {
                    @if (!isLlmInternalKey(entry[0])) {
                      <div class="metric">
                        <span class="metric-label">{{ formatLabel(entry[0]) }}</span>
                        <span class="metric-value">{{ formatValue(entry[1]) }}</span>
                      </div>
                    }
                  }
                  @if (llm.details['error']) {
                    <div class="error-detail">{{ llm.details['error'] }}</div>
                  }
                  @if (llm.details['note']) {
                    <div class="info-note">{{ llm.details['note'] }}</div>
                  }
                }

                @if (llm.configIssues && llm.configIssues.length > 0) {
                  @for (issue of llm.configIssues; track issue) {
                    <div class="config-issue">{{ issue }}</div>
                  }
                }
              </div>
            }
          </div>
        }

        <!-- Client MCP Servers -->
        @if (mcpServers().length > 0) {
          <h2 class="section-title">Client MCP Servers</h2>
          <div class="component-grid">
            @for (mcp of mcpServers(); track (mcp.clientShortCode + ':' + mcp.label)) {
              <div class="status-card">
                <div class="component-header">
                  <div class="component-name">
                    {{ mcp.clientName }}
                    @if (mcp.label !== 'default') {
                      <span class="label-chip">{{ mcp.label }}</span>
                    }
                  </div>
                  <span class="mcp-badge">{{ mcp.clientShortCode }}</span>
                </div>
                <app-mcp-server-info
                  [metadata]="mcpMetadata(mcp)"
                  [status]="mcp.status"
                  [latencyMs]="mcp.latencyMs"
                  [endpoint]="mcp.endpoint"
                  [integrationId]="mcp.integrationId"
                  (verified)="refresh()"
                />
              </div>
            }
          </div>
        }

        <!-- Job queues -->
        @if (queueEntries().length > 0) {
          <h2 class="section-title">Job Queues (BullMQ)</h2>
          <div class="component-grid">
            @for (entry of queueEntries(); track entry[0]) {
              <div class="status-card queue-card">
                <div class="component-name">{{ entry[0] }}</div>
                <div class="queue-stats">
                  <div class="queue-stat">
                    <span class="queue-stat-value">{{ entry[1].waiting }}</span>
                    <span class="queue-stat-label">Waiting</span>
                  </div>
                  <div class="queue-stat">
                    <span class="queue-stat-value active">{{ entry[1].active }}</span>
                    <span class="queue-stat-label">Active</span>
                  </div>
                  <div class="queue-stat">
                    <span class="queue-stat-value completed">{{ entry[1].completed }}</span>
                    <span class="queue-stat-label">Completed</span>
                  </div>
                  <div class="queue-stat">
                    @if (entry[1].failed > 0) {
                      <a
                        class="queue-stat-value failed failed-link"
                        [routerLink]="['/failed-jobs']"
                        [queryParams]="{ queue: entry[0] }"
                        [attr.aria-label]="'View ' + entry[1].failed + ' failed jobs for ' + entry[0]"
                      >{{ entry[1].failed }}</a>
                    } @else {
                      <span class="queue-stat-value failed">{{ entry[1].failed }}</span>
                    }
                    <span class="queue-stat-label">Failed</span>
                  </div>
                </div>
              </div>
            }
          </div>
        }

        <!-- Notification channels -->
        <div style="margin-top: 24px;">
          <app-notification-channels />
        </div>
      }

      @if (error()) {
        <div class="error-banner">
          <span class="error-banner-icon">&#x26A0;</span>
          <span>{{ error() }}</span>
          <button class="btn-retry" (click)="refresh()">Retry</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .system-status-page {
      max-width: 1200px;
      font-family: var(--font-primary);
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .page-title {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.28px;
    }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .last-refresh { font-size: 12px; color: var(--text-tertiary); }

    .btn-refresh {
      background: var(--accent);
      color: var(--text-on-accent);
      border: none;
      padding: 8px 16px;
      border-radius: var(--radius-md);
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-refresh:hover { background: var(--accent-hover); }
    .btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Loading state */
    .loading-state {
      padding: 48px;
      text-align: center;
      font-size: 14px;
      color: var(--text-tertiary);
    }

    /* Overall status banner */
    .overall-status {
      padding: 16px 20px;
      border-radius: var(--radius-lg);
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
      font-family: var(--font-primary);
    }
    .overall-status.up { background: rgba(52,199,89,0.08); border: 1px solid rgba(52,199,89,0.2); }
    .overall-status.degraded { background: rgba(255,149,0,0.08); border: 1px solid rgba(255,149,0,0.2); }
    .overall-status.down { background: rgba(255,59,48,0.08); border: 1px solid rgba(255,59,48,0.2); }
    .overall-status-icon { font-size: 28px; line-height: 1; }
    .overall-status-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .overall-status-subtitle {
      font-size: 14px;
      color: var(--text-secondary);
      margin-top: 2px;
    }

    /* Warning banners */
    .warning-banner {
      background: rgba(255,149,0,0.06);
      border: 1px solid rgba(255,149,0,0.2);
      border-radius: var(--radius-lg);
      padding: 16px 20px;
      margin-bottom: 16px;
    }
    .warning-banner-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .warning-banner-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .warning-icon-text { font-size: 20px; }
    .warning-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .warning-subtitle {
      font-size: 14px;
      color: var(--text-secondary);
    }
    .configure-link {
      color: var(--accent-link);
      text-decoration: none;
      font-weight: 500;
    }
    .configure-link:hover { text-decoration: underline; }
    .config-list {
      margin: 0;
      padding-left: 20px;
    }
    .config-list li {
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: 4px;
    }

    /* Section titles */
    .section-title {
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 24px 0 12px;
    }

    /* Component grid */
    .component-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
    }

    /* Status cards */
    .status-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      padding: 16px;
      box-shadow: var(--shadow-card);
    }

    .component-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .component-name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 500;
      font-size: 15px;
      color: var(--text-primary);
    }

    /* Status dot */
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .status-dot.up { background: var(--color-success); }
    .status-dot.degraded { background: var(--color-warning); }
    .status-dot.down { background: var(--color-error); }
    .status-dot.unknown { background: var(--text-tertiary); }

    /* Status chip */
    .component-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .status-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: monospace;
    }
    .status-chip.up { background: rgba(52,199,89,0.08); color: var(--color-success); }
    .status-chip.degraded { background: rgba(255,149,0,0.08); color: var(--color-warning); }
    .status-chip.down { background: rgba(255,59,48,0.08); color: var(--color-error); }
    .status-chip.unknown { background: var(--bg-muted); color: var(--text-tertiary); }
    .endpoint {
      font-size: 12px;
      color: var(--text-tertiary);
      font-family: monospace;
    }

    /* Metrics */
    .metric {
      display: flex;
      justify-content: space-between;
      padding: 2px 0;
      font-size: 13px;
    }
    .metric-label { color: var(--text-tertiary); }
    .metric-value { font-family: monospace; color: var(--text-primary); }

    .error-detail {
      margin-top: 8px;
      padding: 6px 8px;
      background: rgba(255,59,48,0.06);
      border-radius: var(--radius-sm);
      font-size: 12px;
      color: var(--color-error);
      font-family: monospace;
      word-break: break-word;
    }

    .config-issue {
      margin-top: 4px;
      padding: 4px 8px;
      background: rgba(255,149,0,0.06);
      border-radius: var(--radius-sm);
      font-size: 12px;
      color: var(--color-warning);
    }

    .info-note {
      font-size: 12px;
      color: var(--text-tertiary);
      font-style: italic;
    }

    /* Badge styles */
    .llm-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: rgba(123,31,162,0.08);
      color: #7b1fa2;
      font-family: monospace;
      text-transform: uppercase;
    }
    .mcp-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-active);
      color: var(--accent);
      font-family: monospace;
      text-transform: uppercase;
    }
    .label-chip {
      font-size: 11px;
      padding: 2px 6px;
      background: rgba(52,199,89,0.08);
      border-radius: var(--radius-sm);
      color: var(--color-success);
      font-family: monospace;
    }

    /* Icon button for menu trigger */
    .btn-icon {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 18px;
      color: var(--text-tertiary);
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      line-height: 1;
    }
    .btn-icon:hover { background: var(--bg-hover); }
    .btn-icon:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Inline spinner for controlling state */
    .spinner-inline {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid var(--border-medium);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Queue cards */
    .queue-card .component-name { margin-bottom: 12px; }
    .queue-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      text-align: center;
    }
    .queue-stat-value {
      display: block;
      font-size: 20px;
      font-weight: 500;
      font-family: monospace;
      color: var(--text-primary);
    }
    .queue-stat-value.active { color: var(--accent); }
    .queue-stat-value.completed { color: var(--color-success); }
    .queue-stat-value.failed { color: var(--color-error); }
    .failed-link { text-decoration: none; cursor: pointer; font-weight: 700; }
    .failed-link:hover { text-decoration: underline; }
    .queue-stat-label {
      font-size: 11px;
      color: var(--text-tertiary);
      text-transform: uppercase;
    }

    /* Error banner */
    .error-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 20px;
      background: rgba(255,59,48,0.06);
      border: 1px solid rgba(255,59,48,0.2);
      border-radius: var(--radius-lg);
      color: var(--color-error);
      font-size: 14px;
    }
    .error-banner-icon { font-size: 20px; }
    .btn-retry {
      background: none;
      border: 1px solid var(--color-error);
      color: var(--color-error);
      padding: 4px 12px;
      border-radius: var(--radius-md);
      font-family: var(--font-primary);
      font-size: 13px;
      cursor: pointer;
      margin-left: auto;
    }
    .btn-retry:hover { background: rgba(255,59,48,0.06); }
  `],
})
export class SystemStatusComponent implements OnInit, OnDestroy {
  private statusService = inject(SystemStatusService);
  private aiProviderService = inject(AiProviderService);
  private snackBar = inject(MatSnackBar);
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private refreshSub: Subscription | undefined;
  private aiProviderSub: Subscription | undefined;

  data = signal<SystemStatusResponse | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  controlling = signal<string | null>(null);
  lastRefresh = signal<string | null>(null);
  noAiProviders = signal(false);

  infrastructure = computed(() =>
    this.data()?.components.filter(c => c.type === 'infrastructure') ?? [],
  );
  services = computed(() =>
    this.data()?.components.filter(c => c.type === 'service') ?? [],
  );
  external = computed(() =>
    this.data()?.components.filter(c => c.type === 'external') ?? [],
  );
  llmProviders = computed(() =>
    this.data()?.llmProviders ?? [],
  );
  upCount = computed(() => {
    const componentsUp = this.data()?.components.filter(c => c.status === 'UP').length ?? 0;
    const mcpUp = this.data()?.mcpServers?.filter(s => s.status === 'UP').length ?? 0;
    const llmUp = this.data()?.llmProviders?.filter(l => l.status === 'UP').length ?? 0;
    return componentsUp + mcpUp + llmUp;
  });
  totalMonitored = computed(() =>
    (this.data()?.components.length ?? 0) + (this.data()?.mcpServers?.length ?? 0) + (this.data()?.llmProviders?.length ?? 0),
  );
  mcpServers = computed(() =>
    this.data()?.mcpServers ?? [],
  );
  queueEntries = computed(() =>
    Object.entries(this.data()?.queueStats ?? {}) as [string, QueueStats][],
  );

  ngOnInit(): void {
    this.refresh();
    this.refreshInterval = setInterval(() => this.refresh(), 30000);
  }

  ngOnDestroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    this.refreshSub?.unsubscribe();
    this.aiProviderSub?.unsubscribe();
  }

  refresh(): void {
    this.refreshSub?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.refreshSub = this.statusService.getStatus().subscribe({
      next: (res) => {
        this.data.set(res);
        this.loading.set(false);
        this.lastRefresh.set(new Date().toLocaleTimeString());
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err.error?.error ?? err.message ?? 'Failed to fetch system status');
      },
    });
    this.aiProviderSub?.unsubscribe();
    this.aiProviderSub = this.aiProviderService.listProviders().subscribe({
      next: (providers) => this.noAiProviders.set(providers.filter(p => p.isActive && p.activeModelCount > 0).length === 0),
      error: () => {},
    });
  }

  control(service: string, action: 'start' | 'stop' | 'restart'): void {
    this.controlling.set(service);
    this.statusService.controlService(service, action).subscribe({
      next: (res) => {
        this.controlling.set(null);
        this.snackBar.open(res.message, 'OK', { duration: 4000, panelClass: 'success-snackbar' });
        setTimeout(() => this.refresh(), 3000);
      },
      error: (err) => {
        this.controlling.set(null);
        this.snackBar.open(
          `Failed to ${action} ${service}: ${err.error?.error ?? err.message}`,
          'Dismiss',
          { duration: 6000 },
        );
      },
    });
  }

  statusIcon(status: string): string {
    switch (status) {
      case 'UP': return '\u2705';
      case 'DEGRADED': return '\u26A0\uFE0F';
      case 'DOWN': return '\u274C';
      default: return '\u2753';
    }
  }

  serviceKey(name: string): string {
    const map: Record<string, string> = {
      'PostgreSQL': 'postgres',
      'Redis': 'redis',
      'Copilot API': 'copilot-api',
      'IMAP Worker': 'imap-worker',
      'Issue Resolver': 'issue-resolver',
      'DevOps Worker': 'devops-worker',
      'Status Monitor': 'status-monitor',
      'Ticket Analyzer': 'ticket-analyzer',
      'Probe Worker': 'probe-worker',
      'MCP Database': 'mcp-database',
      'Slack Worker': 'slack-worker',
      'Scheduler Worker': 'scheduler-worker',
      'MCP Platform': 'mcp-platform',
      'MCP Repo': 'mcp-repo',
      'Caddy (Reverse Proxy)': 'caddy',
    };
    return map[name] ?? name.toLowerCase().replace(/\s+/g, '-');
  }

  isServiceInternalKey(key: string): boolean {
    return ['note', 'error', 'httpStatus', 'dockerState', 'healthEndpoint'].includes(key);
  }

  isLlmInternalKey(key: string): boolean {
    return ['model', 'modelsLoaded', 'models', 'error', 'note', 'httpStatus'].includes(key);
  }

  detailEntries(details: Record<string, unknown>): [string, unknown][] {
    return Object.entries(details);
  }

  formatLabel(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
  }

  formatValue(value: unknown): string {
    if (Array.isArray(value)) return value.join(', ') || 'none';
    if (value instanceof Date || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value))) {
      return new Date(value as string).toLocaleString();
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return 'none';
      return entries
        .map(([k, v]) => `${this.formatLabel(k)}: ${this.formatValue(v)}`)
        .join(', ');
    }
    return String(value);
  }

  truncateEndpoint(endpoint: string): string {
    if (endpoint.length > 50) return endpoint.slice(0, 47) + '...';
    return endpoint;
  }

  mcpMetadata(mcp: McpServerStatus): McpDiscoveryMetadata | null {
    if (!mcp.serverName && !mcp.verificationStatus && !mcp.tools) return null;
    return {
      serverName: mcp.serverName,
      serverVersion: mcp.serverVersion,
      tools: mcp.tools,
      systemsCount: mcp.systemsCount,
      lastVerifiedAt: mcp.lastVerifiedAt,
      verificationStatus: mcp.verificationStatus as McpDiscoveryMetadata['verificationStatus'],
      verificationError: mcp.verificationError,
    };
  }
}
