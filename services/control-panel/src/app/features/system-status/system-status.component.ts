import { Component, inject, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
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
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatMenuModule,
    MatDividerModule,
    NotificationChannelsComponent,
    McpServerInfoComponent,
  ],
  template: `
    <div class="page-header">
      <h1>System Status</h1>
      <div class="header-actions">
        @if (lastRefresh()) {
          <span class="last-refresh">Updated {{ lastRefresh() }}</span>
        }
        <button mat-raised-button (click)="refresh()" [disabled]="loading()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </div>
    </div>

    @if (loading() && !data()) {
      <div class="loading-container">
        <mat-spinner diameter="40"></mat-spinner>
        <p>Loading system status...</p>
      </div>
    }

    @if (data()) {
      <!-- Overall status banner -->
      <mat-card class="overall-banner status-{{ data()!.status.toLowerCase() }}">
        <mat-card-content>
          <div class="banner-content">
            <mat-icon class="banner-icon">{{ statusIcon(data()!.status) }}</mat-icon>
            <div>
              <div class="banner-title">System {{ data()!.status === 'UP' ? 'Operational' : data()!.status === 'DEGRADED' ? 'Degraded' : 'Down' }}</div>
              <div class="banner-subtitle">{{ upCount() }} of {{ totalMonitored() }} components operational</div>
            </div>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- Config warnings -->
      @if (data()!.configIssues && data()!.configIssues!.length > 0) {
        <mat-card class="config-warnings">
          <mat-card-header>
            <mat-icon mat-card-avatar class="warning-icon">warning</mat-icon>
            <mat-card-title>Configuration Issues</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <ul class="config-list">
              @for (issue of data()!.configIssues!; track issue) {
                <li>{{ issue }}</li>
              }
            </ul>
          </mat-card-content>
        </mat-card>
      }

      <!-- No AI providers warning -->
      @if (noAiProviders()) {
        <mat-card class="no-ai-warning">
          <mat-card-content>
            <div class="no-ai-content">
              <mat-icon class="no-ai-icon">psychology</mat-icon>
              <div>
                <div class="no-ai-title">No LLM providers configured</div>
                <div class="no-ai-subtitle">AI features are unavailable. <a routerLink="/ai-providers" class="configure-link">Configure providers</a></div>
              </div>
            </div>
          </mat-card-content>
        </mat-card>
      }

      <!-- Component sections -->
      <h2>Infrastructure</h2>
      <div class="component-grid">
        @for (comp of infrastructure(); track comp.name) {
          <mat-card class="component-card">
            <mat-card-content>
              <div class="component-header">
                <div class="component-name">
                  <span class="status-dot status-{{ comp.status.toLowerCase() }}"></span>
                  {{ comp.name }}
                </div>
                @if (comp.controllable) {
                  <button mat-icon-button [matMenuTriggerFor]="menu" [disabled]="controlling() === serviceKey(comp.name)" matTooltip="Service controls">
                    @if (controlling() === serviceKey(comp.name)) {
                      <mat-spinner diameter="20"></mat-spinner>
                    } @else {
                      <mat-icon>more_vert</mat-icon>
                    }
                  </button>
                  <mat-menu #menu="matMenu">
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'restart')">
                      <mat-icon>restart_alt</mat-icon> Restart
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'stop')">
                      <mat-icon>stop</mat-icon> Stop
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'start')">
                      <mat-icon>play_arrow</mat-icon> Start
                    </button>
                  </mat-menu>
                }
              </div>

              <div class="component-meta">
                <span class="status-chip status-{{ comp.status.toLowerCase() }}">{{ comp.status }}</span>
                @if (comp.endpoint) {
                  <span class="endpoint" [matTooltip]="comp.endpoint">{{ comp.endpoint }}</span>
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
            </mat-card-content>
          </mat-card>
        }
      </div>

      <h2>Services</h2>
      <div class="component-grid">
        @for (comp of services(); track comp.name) {
          <mat-card class="component-card">
            <mat-card-content>
              <div class="component-header">
                <div class="component-name">
                  <span class="status-dot status-{{ comp.status.toLowerCase() }}"></span>
                  {{ comp.name }}
                </div>
                @if (comp.controllable) {
                  <button mat-icon-button [matMenuTriggerFor]="svcMenu" [disabled]="controlling() === serviceKey(comp.name)" matTooltip="Service controls">
                    @if (controlling() === serviceKey(comp.name)) {
                      <mat-spinner diameter="20"></mat-spinner>
                    } @else {
                      <mat-icon>more_vert</mat-icon>
                    }
                  </button>
                  <mat-menu #svcMenu="matMenu">
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'restart')">
                      <mat-icon>restart_alt</mat-icon> Restart
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'stop')">
                      <mat-icon>stop</mat-icon> Stop
                    </button>
                    <button mat-menu-item (click)="control(serviceKey(comp.name), 'start')">
                      <mat-icon>play_arrow</mat-icon> Start
                    </button>
                  </mat-menu>
                }
              </div>

              <div class="component-meta">
                <span class="status-chip status-{{ comp.status.toLowerCase() }}">{{ comp.status }}</span>
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
            </mat-card-content>
          </mat-card>
        }
      </div>

      <h2>External Dependencies</h2>
      <div class="component-grid">
        @for (comp of external(); track comp.name) {
          <mat-card class="component-card">
            <mat-card-content>
              <div class="component-header">
                <div class="component-name">
                  <span class="status-dot status-{{ comp.status.toLowerCase() }}"></span>
                  {{ comp.name }}
                </div>
              </div>

              <div class="component-meta">
                <span class="status-chip status-{{ comp.status.toLowerCase() }}">{{ comp.status }}</span>
                @if (comp.endpoint) {
                  <span class="endpoint" [matTooltip]="comp.endpoint">{{ truncateEndpoint(comp.endpoint) }}</span>
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
            </mat-card-content>
          </mat-card>
        }
      </div>

      <!-- LLM Providers -->
      @if (llmProviders().length > 0) {
        <h2>LLM Providers</h2>
        <div class="component-grid">
          @for (llm of llmProviders(); track llm.name) {
            <mat-card class="component-card">
              <mat-card-content>
                <div class="component-header">
                  <div class="component-name">
                    <span class="status-dot status-{{ llm.status.toLowerCase() }}"></span>
                    {{ llm.name.replace('LLM: ', '') }}
                  </div>
                  <span class="llm-badge">LLM</span>
                </div>

                <div class="component-meta">
                  <span class="status-chip status-{{ llm.status.toLowerCase() }}">{{ llm.status }}</span>
                  @if (llm.endpoint) {
                    <span class="endpoint" [matTooltip]="llm.endpoint">{{ truncateEndpoint(llm.endpoint) }}</span>
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
              </mat-card-content>
            </mat-card>
          }
        </div>
      }

      <!-- Client MCP Servers -->
      @if (mcpServers().length > 0) {
        <h2>Client MCP Servers</h2>
        <div class="component-grid">
          @for (mcp of mcpServers(); track (mcp.clientShortCode + ':' + mcp.label)) {
            <mat-card class="component-card">
              <mat-card-content>
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
              </mat-card-content>
            </mat-card>
          }
        </div>
      }

      <!-- Job queues -->
      @if (queueEntries().length > 0) {
        <h2>Job Queues (BullMQ)</h2>
        <div class="component-grid">
          @for (entry of queueEntries(); track entry[0]) {
            <mat-card class="component-card queue-card">
              <mat-card-content>
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
              </mat-card-content>
            </mat-card>
          }
        </div>
      }

      <!-- Notification channels -->
      <div style="margin-top: 24px;">
        <app-notification-channels />
      </div>
    }

    @if (error()) {
      <mat-card class="error-card">
        <mat-card-content>
          <mat-icon>error</mat-icon>
          <span>{{ error() }}</span>
          <button mat-button (click)="refresh()">Retry</button>
        </mat-card-content>
      </mat-card>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .last-refresh { font-size: 12px; color: #888; }
    h2 { margin: 24px 0 12px; font-size: 16px; font-weight: 500; color: #555; }

    .loading-container { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 48px; }

    /* Overall banner */
    .overall-banner { margin-bottom: 16px; }
    .overall-banner.status-up { background: #e8f5e9; }
    .overall-banner.status-degraded { background: #fff3e0; }
    .overall-banner.status-down { background: #ffebee; }
    .banner-content { display: flex; align-items: center; gap: 16px; padding: 8px 0; }
    .banner-icon { font-size: 40px; width: 40px; height: 40px; }
    .status-up .banner-icon { color: #2e7d32; }
    .status-degraded .banner-icon { color: #e65100; }
    .status-down .banner-icon { color: #c62828; }
    .banner-title { font-size: 20px; font-weight: 500; }
    .banner-subtitle { font-size: 14px; color: #666; }

    /* Config warnings */
    .config-warnings { margin-bottom: 16px; border-left: 4px solid #ff9800; }
    .warning-icon { color: #ff9800 !important; background: transparent !important; }
    .config-list { margin: 8px 0 0; padding-left: 20px; }
    .config-list li { color: #666; font-size: 14px; margin-bottom: 4px; }

    /* No AI warning */
    .no-ai-warning { margin-bottom: 16px; border-left: 4px solid #ff9800; }
    .no-ai-content { display: flex; align-items: center; gap: 16px; padding: 8px 0; }
    .no-ai-icon { font-size: 32px; width: 32px; height: 32px; color: #ff9800; }
    .no-ai-title { font-size: 16px; font-weight: 500; }
    .no-ai-subtitle { font-size: 14px; color: #666; }
    .configure-link { color: #1976d2; text-decoration: none; font-weight: 500; }
    .configure-link:hover { text-decoration: underline; }

    /* Component grid */
    .component-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
    }

    .component-card { position: relative; }
    .component-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .component-name { display: flex; align-items: center; gap: 8px; font-weight: 500; font-size: 15px; }

    /* Status dot */
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .status-dot.status-up { background: #4caf50; }
    .status-dot.status-down { background: #f44336; }
    .status-dot.status-degraded { background: #ff9800; }
    .status-dot.status-unknown { background: #9e9e9e; }

    /* Status chip */
    .component-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .status-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: monospace;
    }
    .status-chip.status-up { background: #e8f5e9; color: #2e7d32; }
    .status-chip.status-down { background: #ffebee; color: #c62828; }
    .status-chip.status-degraded { background: #fff3e0; color: #e65100; }
    .status-chip.status-unknown { background: #f5f5f5; color: #757575; }
    .endpoint { font-size: 12px; color: #888; font-family: monospace; }

    /* Metrics */
    .metric {
      display: flex;
      justify-content: space-between;
      padding: 2px 0;
      font-size: 13px;
    }
    .metric-label { color: #888; }
    .metric-value { font-family: monospace; color: #333; }

    .error-detail {
      margin-top: 8px;
      padding: 6px 8px;
      background: #ffebee;
      border-radius: 4px;
      font-size: 12px;
      color: #c62828;
      font-family: monospace;
      word-break: break-word;
    }

    .config-issue {
      margin-top: 4px;
      padding: 4px 8px;
      background: #fff3e0;
      border-radius: 4px;
      font-size: 12px;
      color: #e65100;
    }

    .info-note {
      font-size: 12px;
      color: #888;
      font-style: italic;
    }

    /* LLM badge */
    .llm-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: #f3e5f5;
      color: #7b1fa2;
      font-family: monospace;
      text-transform: uppercase;
    }

    /* MCP badge */
    .mcp-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: #e3f2fd;
      color: #1565c0;
      font-family: monospace;
      text-transform: uppercase;
    }
    .label-chip {
      font-size: 11px;
      padding: 2px 6px;
      background: #e8f5e9;
      border-radius: 4px;
      color: #2e7d32;
      font-family: monospace;
    }

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
    }
    .queue-stat-value.active { color: #1565c0; }
    .queue-stat-value.completed { color: #2e7d32; }
    .queue-stat-value.failed { color: #c62828; }
    .failed-link { text-decoration: none; cursor: pointer; font-weight: 700; }
    .failed-link:hover { text-decoration: underline; }
    .queue-stat-label {
      font-size: 11px;
      color: #888;
      text-transform: uppercase;
    }

    /* Error card */
    .error-card mat-card-content {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #c62828;
    }
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
        // Refresh status after a brief delay to let Docker act
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
      case 'UP': return 'check_circle';
      case 'DEGRADED': return 'warning';
      case 'DOWN': return 'error';
      default: return 'help';
    }
  }

  /** Map display name to Docker Compose service key */
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
      'Caddy (Reverse Proxy)': 'caddy',
    };
    return map[name] ?? name.toLowerCase().replace(/\s+/g, '-');
  }

  /** Keys from the health response that are already displayed or should be hidden */
  isServiceInternalKey(key: string): boolean {
    return ['note', 'error', 'httpStatus', 'dockerState', 'healthEndpoint'].includes(key);
  }

  /** Keys from LLM provider details already displayed or internal */
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

  /** Build McpDiscoveryMetadata from the McpServerStatus fields returned by the API. */
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
