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
  IconComponent,
  type IconName,
} from '../../../../shared/components/index.js';
import { McpServerInfoComponent } from '../../../../shared/components/mcp-server-info.component';
import { IntegrationDialogComponent } from '../../../integrations/integration-dialog.component';

const SENSITIVE_KEYS = ['encryptedpassword', 'encryptedpat', 'password', 'pat', 'token', 'secret', 'apikey'];

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
    IconComponent,
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
            <app-icon [name]="integrationIconName(integ.type)" size="sm" class="type-icon" />
            <strong class="integ-type">{{ integ.type }}</strong>
            @if (integ.label && integ.label !== 'default') {
              <span class="label-chip">{{ integ.label }}</span>
            }
            <app-toggle-switch
              [checked]="integ.isActive"
              [label]="integ.isActive ? 'Active' : 'Inactive'"
              (checkedChange)="toggleIntegration(integ, $event)" />
            <span class="spacer"></span>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Edit integration" (click)="openEditDialog(integ)"><app-icon name="edit" size="sm" /></app-bronco-button>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Delete integration" (click)="deleteIntegration(integ.id)"><app-icon name="delete" size="sm" /></app-bronco-button>
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

  integrationIconName(type: string): IconName {
    switch (type) {
      case 'IMAP': return 'email';
      case 'AZURE_DEVOPS': return 'gear';
      case 'MCP_DATABASE': return 'database';
      case 'SLACK': return 'comment';
      default: return 'link';
    }
  }

  redactConfig(config: Record<string, unknown>): Record<string, unknown> {
    return this.redactValue(config) as Record<string, unknown>;
  }

  /**
   * Recursively walks an arbitrary value and redacts any field whose key
   * (compared case-insensitively) appears in `SENSITIVE_KEYS`. Handles nested
   * objects and arrays so secrets buried in nested integration configs aren't
   * accidentally rendered in the JSON preview.
   */
  private redactValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(v => this.redactValue(v));
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
          out[key] = '********';
        } else {
          out[key] = this.redactValue(v);
        }
      }
      return out;
    }
    return value;
  }
}
