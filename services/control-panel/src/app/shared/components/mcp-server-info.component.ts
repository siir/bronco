import { Component, input, output, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { IntegrationService, type McpDiscoveryMetadata } from '../../core/services/integration.service';

@Component({
  selector: 'app-mcp-server-info',
  standalone: true,
  imports: [MatIconModule, MatButtonModule, MatTooltipModule, MatProgressSpinnerModule, MatSnackBarModule],
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
        <div class="endpoint-row" [matTooltip]="endpoint()!">
          <mat-icon class="small-icon">link</mat-icon>
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
          <button mat-stroked-button (click)="onVerify()" [disabled]="verifying">
            @if (verifying) {
              <mat-spinner diameter="16"></mat-spinner>
            } @else {
              <mat-icon>refresh</mat-icon>
            }
            Verify
          </button>
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
      background: #e8eaf6; color: #3949ab; border-radius: 4px;
    }
    .health-row { display: flex; align-items: center; gap: 8px; }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
    }
    .status-dot.status-up { background: #4caf50; }
    .status-dot.status-down { background: #f44336; }
    .status-dot.status-degraded { background: #ff9800; }
    .status-dot.status-unknown { background: #9e9e9e; }
    .status-chip {
      font-size: 11px; font-weight: 600; padding: 1px 6px;
      border-radius: 4px; font-family: monospace;
    }
    .status-chip.status-up { background: #e8f5e9; color: #2e7d32; }
    .status-chip.status-down { background: #ffebee; color: #c62828; }
    .status-chip.status-degraded { background: #fff3e0; color: #e65100; }
    .status-chip.status-unknown { background: #f5f5f5; color: #757575; }
    .latency { font-size: 12px; color: #888; font-family: monospace; }
    .endpoint-row {
      display: flex; align-items: center; gap: 4px;
      font-size: 12px; color: #888;
    }
    .endpoint-row code { font-size: 12px; }
    .small-icon { font-size: 14px; width: 14px; height: 14px; color: #aaa; }
    .verification-row { display: flex; align-items: center; gap: 8px; }
    .verification-chip {
      font-size: 11px; font-weight: 600; padding: 1px 6px;
      border-radius: 4px;
    }
    .verification-chip.success { background: #e8f5e9; color: #2e7d32; }
    .verification-chip.failed { background: #ffebee; color: #c62828; }
    .last-verified { font-size: 11px; color: #999; }
    .error-detail {
      padding: 4px 8px; background: #ffebee; border-radius: 4px;
      font-size: 12px; color: #c62828; font-family: monospace; word-break: break-word;
    }
    .metric { display: flex; justify-content: space-between; font-size: 13px; }
    .metric-label { color: #888; }
    .metric-value { font-family: monospace; color: #333; }
    .tools-section { margin-top: 4px; }
    .tools-header { font-size: 12px; font-weight: 500; color: #666; margin-bottom: 4px; }
    .tools-list {
      display: flex; flex-direction: column; gap: 2px;
      padding: 4px 8px; background: #fafafa; border-radius: 4px;
      max-height: 200px; overflow-y: auto;
    }
    .tool-item { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
    .tool-name { color: #1565c0; font-size: 12px; white-space: nowrap; }
    .tool-desc { color: #888; }
    .verify-action { margin-top: 4px; }
    .verify-action button { font-size: 13px; }
    .verify-action mat-spinner { display: inline-block; margin-right: 4px; }
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
  private snackBar = inject(MatSnackBar);

  verifying = false;

  onVerify(): void {
    const id = this.integrationId();
    if (!id) return;
    this.verifying = true;
    this.integrationService.verify(id).subscribe({
      next: () => {
        this.verifying = false;
        this.snackBar.open('Verification job enqueued', 'OK', { duration: 3000 });
        this.verified.emit();
      },
      error: (err) => {
        this.verifying = false;
        this.snackBar.open(err.error?.error ?? 'Verification failed', 'OK', { duration: 5000 });
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
