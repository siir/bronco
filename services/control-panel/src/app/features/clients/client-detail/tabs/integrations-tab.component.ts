import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { JsonPipe } from '@angular/common';
import { ClientIntegration, IntegrationService } from '../../../../core/services/integration.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  CardComponent,
  ToggleSwitchComponent,
  DialogComponent,
} from '../../../../shared/components/index.js';
import { McpServerInfoComponent } from '../../../../shared/components/mcp-server-info.component';
import { IntegrationDialogComponent } from '../../../integrations/integration-dialog.component';

const SENSITIVE_KEYS = ['encryptedPassword', 'encryptedPat', 'password', 'pat', 'token', 'secret', 'apiKey'];

@Component({
  selector: 'app-client-integrations-tab',
  standalone: true,
  imports: [
    JsonPipe,
    BroncoButtonComponent,
    CardComponent,
    ToggleSwitchComponent,
    DialogComponent,
    McpServerInfoComponent,
    IntegrationDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Integrations</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openAddDialog()">+ Add Integration</app-bronco-button>
      </div>

      @for (integ of integrations(); track integ.id) {
        <app-card padding="md" class="integration-card" [class.inactive-card]="!integ.isActive">
          <div class="integ-header">
            <span class="type-icon">{{ integrationIcon(integ.type) }}</span>
            <strong class="integ-type">{{ integ.type }}</strong>
            @if (integ.label && integ.label !== 'default') {
              <span class="label-chip">{{ integ.label }}</span>
            }
            <app-toggle-switch
              [checked]="integ.isActive"
              [label]="integ.isActive ? 'Active' : 'Inactive'"
              (checkedChange)="toggleIntegration(integ, $event)" />
            <span class="spacer"></span>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Edit integration" (click)="openEditDialog(integ)">&#x270E;</app-bronco-button>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Delete integration" (click)="deleteIntegration(integ.id)">&#x1F5D1;</app-bronco-button>
          </div>
          @if (integ.notes) { <p class="integ-notes">{{ integ.notes }}</p> }
          @if (integ.type === 'MCP_DATABASE' && integ.metadata) {
            <app-mcp-server-info
              [metadata]="integ.metadata"
              [integrationId]="integ.id"
              (verified)="load()" />
          } @else {
            <pre class="config-preview">{{ redactConfig(integ.config) | json }}</pre>
          }
        </app-card>
      } @empty {
        <p class="empty">No integrations configured. Add IMAP, Azure DevOps, or MCP Database integrations.</p>
      }
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        [title]="editing() ? 'Edit Integration' : 'Add Integration'"
        maxWidth="600px"
        (openChange)="showDialog.set(false)">
        <app-integration-dialog-content
          [clientId]="clientId()"
          [integration]="editing() ?? undefined"
          (saved)="onSaved()"
          (cancelled)="showDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    :host { display: block; }

    .tab-section { padding: 16px 0; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .integration-card {
      margin-bottom: 12px;
    }

    .integration-card.inactive-card {
      opacity: 0.6;
    }

    .integ-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .type-icon {
      font-size: 16px;
      line-height: 1;
    }

    .integ-type {
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
    }

    .label-chip {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--color-success-subtle);
      color: var(--color-success);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    }

    .spacer { flex: 1; }

    .integ-notes {
      color: var(--text-secondary);
      font-family: var(--font-primary);
      font-size: 13px;
      margin: 10px 0 4px;
      line-height: 1.5;
    }

    .config-preview {
      background: var(--bg-code);
      color: var(--text-code);
      padding: 10px 14px;
      border-radius: var(--radius-md);
      font-size: 12px;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      overflow-x: auto;
      margin: 10px 0 0;
    }

    .empty {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 14px;
      padding: 32px 16px;
      text-align: center;
    }
  `],
})
export class ClientIntegrationsTabComponent implements OnInit {
  clientId = input.required<string>();

  private integrationService = inject(IntegrationService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  integrations = signal<ClientIntegration[]>([]);
  showDialog = signal(false);
  editing = signal<ClientIntegration | null>(null);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.integrationService.getIntegrations(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(i => this.integrations.set(i));
  }

  openAddDialog(): void {
    this.editing.set(null);
    this.showDialog.set(true);
  }

  openEditDialog(integ: ClientIntegration): void {
    this.editing.set(integ);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }

  toggleIntegration(integ: ClientIntegration, checked: boolean): void {
    // Optimistic update so the toggle doesn't snap back
    this.integrations.update(list => list.map(i => i.id === integ.id ? { ...i, isActive: checked } : i));
    this.integrationService.updateIntegration(integ.id, { isActive: checked })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.toast.success(`Integration ${checked ? 'enabled' : 'disabled'}`),
        error: (err) => {
          // Revert and reload authoritative state
          this.integrations.update(list => list.map(i => i.id === integ.id ? { ...i, isActive: !checked } : i));
          this.toast.error(err.error?.message ?? err.error?.error ?? 'Toggle failed');
          this.load();
        },
      });
  }

  deleteIntegration(id: string): void {
    this.integrationService.deleteIntegration(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Integration deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
      });
  }

  integrationIcon(type: string): string {
    switch (type) {
      case 'IMAP': return '\u2709';        // ✉
      case 'AZURE_DEVOPS': return '\u2699'; // ⚙
      case 'MCP_DATABASE': return '\u{1F5C4}'; // 🗄
      case 'SLACK': return '\u{1F4AC}';     // 💬
      default: return '\u{1F50C}';          // 🔌
    }
  }

  redactConfig(config: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      redacted[key] = SENSITIVE_KEYS.includes(key) ? '********' : value;
    }
    return redacted;
  }
}
