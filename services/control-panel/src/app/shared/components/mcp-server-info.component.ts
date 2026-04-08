import { Component, input, output, inject } from '@angular/core';
import { BroncoButtonComponent } from './bronco-button.component.js';
import { IntegrationService, type McpDiscoveryMetadata } from '../../core/services/integration.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-mcp-server-info',
  standalone: true,
  imports: [BroncoButtonComponent],
  template: `
    <div class="mcp-info">
      <!-- Server identity -->
      @if (metadata()?.serverName) {
        <div class="server-identity">
          <span class="server-name">{{ metadata()!.serverName }}</span>
          @if (metadata()?.serverVersion) {
            <span class="version-badge">v{{ metadata()!.serverVersion }}</span>
          }
        </div>
      }

      <!-- Health status -->
      @if (status()) {
        <div class="health-row">
          <span class="status-dot status-{{ status()!.toLowerCase() }}"></span>
          <span class="status-chip status-{{ status()!.toLowerCase() }}">{{ status() }}</span>
          @if (latencyMs() !== undefined) {
            <span class="latency">{{ latencyMs() }}ms</span>
          }
        </div>
      }

      <!-- Endpoint -->
      @if (endpoint()) {
        <div class="endpoint-row" [attr.title]="endpoint()!" [attr.aria-label]="'Endpoint: ' + endpoint()!">
          <span class="small-icon" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </span>
          <code>{{ truncate(endpoint()!, 50) }}</code>
        </div>
      }

      <!-- Verification status -->
      @if (metadata()?.verificationStatus) {
        <div class="verification-row">
          <span class="verification-chip"
            [class.success]="metadata()!.verificationStatus === 'success'"
            [class.failed]="metadata()!.verificationStatus === 'failed'">
            {{ metadata()!.verificationStatus === 'success' ? 'Verified' : 'Verification Failed' }}
          </span>
          @if (metadata()?.lastVerifiedAt) {
            <span class="last-verified">{{ relativeTime(metadata()!.lastVerifiedAt!) }}</span>
          }
        </div>
      }

      <!-- Verification error -->
      @if (metadata()?.verificationError) {
        <div class="error-detail">{{ metadata()!.verificationError }}</div>
      }

      <!-- Systems count -->
      @if (metadata()?.systemsCount != null) {
        <div class="metric">
          <span class="metric-label">Systems</span>
          <span class="metric-value">{{ metadata()!.systemsCount }} connected</span>
        </div>
      }

      <!-- Tools list -->
      @if (metadata()?.tools && metadata()!.tools!.length > 0) {
        <div class="tools-section">
          <div class="tools-header">Tools ({{ metadata()!.tools!.length }})</div>
          <div class="tools-list">
            @for (tool of metadata()!.tools!; track tool.name) {
              <div class="tool-item">
                <code class="tool-name">{{ tool.name }}</code>
                @if (tool.description) {
                  <span class="tool-desc">{{ truncate(tool.description, 80) }}</span>
                }
              </div>
            }
          </div>
        </div>
      }

      <!-- Verify button -->
      @if (integrationId()) {
        <div class="verify-action">
          <app-bronco-button variant="secondary" [disabled]="verifying" (click)="onVerify()">
            @if (verifying) {
              <span class="spinner" aria-hidden="true"></span>
            } @else {
              <span aria-hidden="true">&#x21BB;</span>
            }
            Verify
          </app-bronco-button>
        </div>
      }
    </div>
  `,
  styles: [`
    .mcp-info { display: flex; flex-direction: column; gap: 6px; }
    .server-identity { display: flex; align-items: center; gap: 8px; }
    .server-name { font-weight: 500; font-size: 14px; }
    .version-badge {
      font-size: 11px; font-family: monospace; padding: 1px 6px;
      background: var(--color-info-subtle); color: var(--color-info); border-radius: 4px;
    }
    .health-row { display: flex; align-items: center; gap: 8px; }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .status-dot.status-up { background: var(--color-success); }
    .status-dot.status-down { background: var(--color-error); }
    .status-dot.status-degraded { background: var(--color-warning); }
    .status-dot.status-unknown { background: var(--text-tertiary); }
    .status-chip {
      font-size: 11px; font-weight: 600; padding: 1px 6px;
      border-radius: 4px; font-family: monospace;
    }
    .status-chip.status-up { background: var(--color-success-subtle); color: var(--color-success); }
    .status-chip.status-down { background: var(--color-error-subtle); color: var(--color-error); }
    .status-chip.status-degraded { background: var(--color-warning-subtle); color: var(--color-warning); }
    .status-chip.status-unknown { background: var(--bg-muted); color: var(--text-tertiary); }
    .latency { font-size: 12px; color: var(--text-tertiary); font-family: monospace; }
    .endpoint-row {
      display: flex; align-items: center; gap: 4px;
      font-size: 12px; color: var(--text-tertiary);
    }
    .endpoint-row code { font-size: 12px; }
    .small-icon { display: inline-flex; align-items: center; color: var(--text-tertiary); }
    .verification-row { display: flex; align-items: center; gap: 8px; }
    .verification-chip {
      font-size: 11px; font-weight: 600; padding: 1px 6px;
      border-radius: 4px;
    }
    .verification-chip.success { background: var(--color-success-subtle); color: var(--color-success); }
    .verification-chip.failed { background: var(--color-error-subtle); color: var(--color-error); }
    .last-verified { font-size: 11px; color: var(--text-tertiary); }
    .error-detail {
      padding: 4px 8px; background: var(--color-error-subtle); border-radius: 4px;
      font-size: 12px; color: var(--color-error); font-family: monospace; word-break: break-word;
    }
    .metric { display: flex; justify-content: space-between; font-size: 13px; }
    .metric-label { color: var(--text-tertiary); }
    .metric-value { font-family: monospace; color: var(--text-primary); }
    .tools-section { margin-top: 4px; }
    .tools-header { font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 4px; }
    .tools-list {
      display: flex; flex-direction: column; gap: 2px;
      padding: 4px 8px; background: var(--bg-card); border-radius: 4px;
      max-height: 200px; overflow-y: auto;
    }
    .tool-item { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
    .tool-name { color: var(--accent-link); font-size: 12px; white-space: nowrap; }
    .tool-desc { color: var(--text-tertiary); }
    .verify-action { margin-top: 4px; }

    /* CSS-only spinner */
    @keyframes mcp-spin {
      to { transform: rotate(360deg); }
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-medium);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: mcp-spin 0.7s linear infinite;
      flex-shrink: 0;
    }
  `],
})
export class McpServerInfoComponent {
  metadata = input<McpDiscoveryMetadata | null>(null);
  status = input<string | undefined>(undefined);
  latencyMs = input<number | undefined>(undefined);
  endpoint = input<string | undefined>(undefined);
  integrationId = input<string | undefined>(undefined);
  verified = output<void>();

  private integrationService = inject(IntegrationService);
  private toast = inject(ToastService);

  verifying = false;

  onVerify(): void {
    const id = this.integrationId();
    if (!id) return;
    this.verifying = true;
    this.integrationService.verify(id).subscribe({
      next: () => {
        this.verifying = false;
        this.toast.success('Verification job enqueued');
        this.verified.emit();
      },
      error: (err) => {
        this.verifying = false;
        this.toast.error(err.error?.error ?? 'Verification failed');
      },
    });
  }

  truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max - 3) + '...' : str;
  }

  relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}
