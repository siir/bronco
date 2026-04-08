import { Component, inject, input, output, OnInit, signal } from '@angular/core';
import { IntegrationService } from '../../core/services/integration.service';
import type { ClientIntegration } from '../../core/services/integration.service';
import { AuthService } from '../../core/services/auth.service';
import { McpToolVisibilityDialogComponent } from './mcp-tool-visibility-dialog.component';
import { ToastService } from '../../core/services/toast.service';
import { DialogComponent, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-integration-dialog-content',
  standalone: true,
  imports: [
    FormFieldComponent,
    TextInputComponent,
    TextareaComponent,
    SelectComponent,
    ToggleSwitchComponent,
    BroncoButtonComponent,
    DialogComponent,
    McpToolVisibilityDialogComponent,
  ],
  template: `
    <div class="form-grid">
      <app-form-field label="Type">
        <app-select
          [value]="type"
          [options]="typeOptions"
          [disabled]="editing"
          (valueChange)="type = $event; onTypeChange()" />
      </app-form-field>

      <app-form-field label="Label" hint="Allows multiple integrations of the same type per client">
        <app-text-input
          [value]="label"
          placeholder="e.g. prod, dev, staging"
          (valueChange)="label = $event" />
      </app-form-field>

      @if (type === 'IMAP') {
        @if (imapLoopWarning) {
          <div class="loop-warning">
            <strong>Warning:</strong> This inbox email matches your login email ({{ currentUserEmail }}).
            Automated replies sent to this address will be ingested as new tickets, creating an email loop.
            Use a separate email address for ticket ingestion.
          </div>
        }
        <app-form-field label="IMAP Host">
          <app-text-input [value]="imap.host" placeholder="imap.gmail.com" (valueChange)="imap.host = $event" />
        </app-form-field>
        <app-form-field label="IMAP Port">
          <app-text-input [value]="'' + imap.port" type="number" (valueChange)="imap.port = +$event" />
        </app-form-field>
        <app-form-field label="User">
          <app-text-input [value]="imap.user" (valueChange)="imap.user = $event; checkImapLoop()" />
        </app-form-field>
        <app-form-field label="Password" [hint]="editing ? 'Leave blank to keep existing password' : ''">
          <app-text-input
            [value]="imap.encryptedPassword"
            type="password"
            [placeholder]="editing ? '(unchanged)' : ''"
            (valueChange)="imap.encryptedPassword = $event" />
        </app-form-field>
        <app-form-field label="Poll Interval (seconds)">
          <app-text-input [value]="'' + imap.pollIntervalSeconds" type="number" (valueChange)="imap.pollIntervalSeconds = +$event" />
        </app-form-field>
      }

      @if (type === 'AZURE_DEVOPS') {
        <app-form-field label="Organization URL">
          <app-text-input [value]="azdo.orgUrl" placeholder="https://dev.azure.com/org" (valueChange)="azdo.orgUrl = $event" />
        </app-form-field>
        <app-form-field label="Project">
          <app-text-input [value]="azdo.project" (valueChange)="azdo.project = $event" />
        </app-form-field>
        <app-form-field label="Personal Access Token" [hint]="editing ? 'Leave blank to keep existing token' : ''">
          <app-text-input
            [value]="azdo.encryptedPat"
            type="password"
            [placeholder]="editing ? '(unchanged)' : ''"
            (valueChange)="azdo.encryptedPat = $event" />
        </app-form-field>
        <app-form-field label="Assigned User">
          <app-text-input [value]="azdo.assignedUser" (valueChange)="azdo.assignedUser = $event" />
        </app-form-field>
        <app-form-field label="Poll Interval (seconds)">
          <app-text-input [value]="'' + azdo.pollIntervalSeconds" type="number" (valueChange)="azdo.pollIntervalSeconds = +$event" />
        </app-form-field>
      }

      @if (type === 'MCP_DATABASE') {
        <app-form-field label="MCP Database URL" hint="https:// will be added automatically if omitted">
          <app-text-input [value]="mcp.url" placeholder="mcp-db.example.com:3100" (valueChange)="mcp.url = $event" />
        </app-form-field>

        @if (showAdvanced) {
          <app-form-field label="Health Path" [hint]="editing ? 'Leave blank to disable health checks' : 'Default: /health'">
            <app-text-input
              [value]="mcp.healthPath === null ? '' : mcp.healthPath"
              placeholder="/health"
              (valueChange)="mcp.healthPath = $event === '' ? (editing ? null : '') : $event" />
          </app-form-field>
          <app-form-field label="MCP Path" hint="Streamable HTTP endpoint for MCP protocol calls">
            <app-text-input [value]="mcp.mcpPath" placeholder="/mcp" (valueChange)="mcp.mcpPath = $event" />
          </app-form-field>
          <app-form-field label="API Key" [hint]="editing ? 'Leave blank to keep existing key' : ''">
            <app-text-input
              [value]="mcp.apiKey"
              type="password"
              [placeholder]="editing ? '(unchanged)' : '(optional)'"
              (valueChange)="mcp.apiKey = $event" />
          </app-form-field>
          <app-form-field label="Auth Header" hint="How the API key is sent to the MCP server">
            <app-select [value]="mcp.authHeader" [options]="authHeaderOptions" (valueChange)="mcp.authHeader = $event" />
          </app-form-field>
        }

        <app-bronco-button variant="ghost" (click)="showAdvanced = !showAdvanced">
          {{ showAdvanced ? 'Hide' : 'Show' }} advanced options
        </app-bronco-button>

        @if (discoveredTools.length > 0) {
          <div class="tool-visibility-section">
            <span class="tool-summary">
              {{ discoveredTools.length - disabledTools.size }}/{{ discoveredTools.length }} tools enabled
              @if (disabledTools.size > 0) { <span class="disabled-count">({{ disabledTools.size }} hidden)</span> }
            </span>
            <app-bronco-button variant="secondary" (click)="openToolVisibility()">Manage Tools</app-bronco-button>
          </div>
        }
      }

      @if (type === 'SLACK') {
        <app-form-field label="Bot Token" [hint]="editing ? 'Leave blank to keep existing token' : ''">
          <app-text-input
            [value]="slack.encryptedBotToken"
            type="password"
            [placeholder]="editing ? '(unchanged)' : 'xoxb-...'"
            (valueChange)="slack.encryptedBotToken = $event" />
        </app-form-field>
        <app-form-field label="App-Level Token" [hint]="editing ? 'Leave blank to keep existing token' : ''">
          <app-text-input
            [value]="slack.encryptedAppToken"
            type="password"
            [placeholder]="editing ? '(unchanged)' : 'xapp-...'"
            (valueChange)="slack.encryptedAppToken = $event" />
        </app-form-field>
        <app-form-field label="Default Channel ID" hint="Channel where ticket updates are posted">
          <app-text-input [value]="slack.defaultChannelId" placeholder="C0123456789" (valueChange)="slack.defaultChannelId = $event" />
        </app-form-field>
        <app-toggle-switch
          [checked]="slack.enabled"
          [label]="slack.enabled ? 'Enabled' : 'Disabled'"
          (checkedChange)="slack.enabled = $event" />
      }

      <app-form-field label="Notes">
        <app-textarea [value]="notes" [rows]="2" (valueChange)="notes = $event" />
      </app-form-field>

      @if (editing) {
        <app-toggle-switch
          [checked]="isActive"
          [label]="isActive ? 'Active' : 'Inactive'"
          (checkedChange)="isActive = $event" />
      }
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!type" (click)="save()">
        {{ editing ? 'Save' : 'Create' }}
      </app-bronco-button>
    </div>

    @if (showToolVisibility()) {
      <app-dialog [open]="true" title="Tool Visibility" maxWidth="480px" (openChange)="showToolVisibility.set(false)">
        <app-mcp-tool-visibility-dialog-content
          [tools]="discoveredTools"
          [initialDisabledTools]="disabledTools"
          (applied)="onToolsApplied($event)"
          (cancelled)="showToolVisibility.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .loop-warning { background: var(--color-warning-subtle); border: 1px solid var(--color-warning); border-radius: var(--radius-md); padding: 10px 14px; font-size: 13px; color: var(--color-error); line-height: 1.4; }
    .tool-visibility-section { display: flex; align-items: center; gap: 12px; margin-top: 4px; border-top: 1px solid var(--border-light); padding-top: 12px; }
    .tool-summary { font-size: 13px; color: var(--text-secondary); flex: 1; }
    .disabled-count { color: var(--color-error); margin-left: 4px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class IntegrationDialogComponent implements OnInit {
  private integrationService = inject(IntegrationService);
  private authService = inject(AuthService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  integration = input<ClientIntegration | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  showToolVisibility = signal(false);

  editing = false;
  type = '';
  label = 'default';
  notes = '';
  isActive = true;

  imap = { host: 'imap.gmail.com', port: 993, user: '', encryptedPassword: '', pollIntervalSeconds: 60 };
  azdo = { orgUrl: '', project: '', encryptedPat: '', assignedUser: '', pollIntervalSeconds: 120 };
  mcp: { url: string; healthPath: string | null; mcpPath: string; apiKey: string; authHeader: string } = { url: '', healthPath: '', mcpPath: '', apiKey: '', authHeader: 'bearer' };
  slack = { encryptedBotToken: '', encryptedAppToken: '', defaultChannelId: '', enabled: true };
  showAdvanced = false;
  discoveredTools: Array<{ name: string; description: string }> = [];
  disabledTools = new Set<string>();
  imapLoopWarning = false;
  currentUserEmail = '';

  typeOptions = [
    { value: 'IMAP', label: 'IMAP (Email)' },
    { value: 'AZURE_DEVOPS', label: 'Azure DevOps' },
    { value: 'MCP_DATABASE', label: 'MCP Database' },
    { value: 'SLACK', label: 'Slack' },
  ];

  authHeaderOptions = [
    { value: 'bearer', label: 'Authorization: Bearer (default)' },
    { value: 'x-api-key', label: 'x-api-key' },
  ];

  private readonly secretFields: Record<string, string[]> = {
    IMAP: ['encryptedPassword'],
    AZURE_DEVOPS: ['encryptedPat'],
    MCP_DATABASE: ['apiKey'],
    SLACK: ['encryptedBotToken', 'encryptedAppToken'],
  };

  ngOnInit(): void {
    this.currentUserEmail = this.authService.currentUser()?.email ?? '';

    const integ = this.integration();
    if (integ) {
      this.editing = true;
      this.type = integ.type;
      this.label = integ.label;
      this.notes = integ.notes ?? '';
      this.isActive = integ.isActive;

      const config = { ...integ.config };
      for (const field of this.secretFields[integ.type] ?? []) {
        if (field in config) config[field] = '';
      }

      switch (integ.type) {
        case 'IMAP':
          Object.assign(this.imap, config);
          this.checkImapLoop();
          break;
        case 'AZURE_DEVOPS':
          Object.assign(this.azdo, config);
          break;
        case 'MCP_DATABASE':
          Object.assign(this.mcp, config);
          if (config['healthPath'] !== undefined || config['mcpPath'] || config['apiKey'] || config['authHeader']) {
            this.showAdvanced = true;
          }
          if (integ.metadata?.tools) {
            this.discoveredTools = integ.metadata.tools;
          }
          if (Array.isArray(integ.config['disabledTools'])) {
            this.disabledTools = new Set(integ.config['disabledTools'] as string[]);
          }
          break;
        case 'SLACK':
          Object.assign(this.slack, config);
          break;
      }
    }
  }

  onTypeChange(): void {
    this.imap = { host: 'imap.gmail.com', port: 993, user: '', encryptedPassword: '', pollIntervalSeconds: 60 };
    this.azdo = { orgUrl: '', project: '', encryptedPat: '', assignedUser: '', pollIntervalSeconds: 120 };
    this.mcp = { url: '', healthPath: '', mcpPath: '', apiKey: '', authHeader: 'bearer' };
    this.slack = { encryptedBotToken: '', encryptedAppToken: '', defaultChannelId: '', enabled: true };
    this.showAdvanced = false;
    this.discoveredTools = [];
    this.disabledTools = new Set();
  }

  openToolVisibility(): void {
    this.showToolVisibility.set(true);
  }

  onToolsApplied(result: Set<string>): void {
    this.disabledTools = result;
    this.showToolVisibility.set(false);
  }

  checkImapLoop(): void {
    if (!this.currentUserEmail || !this.imap.user) {
      this.imapLoopWarning = false;
      return;
    }
    this.imapLoopWarning =
      this.imap.user.trim().toLowerCase() === this.currentUserEmail.trim().toLowerCase();
  }

  save(): void {
    let config: Record<string, unknown> = {};
    switch (this.type) {
      case 'IMAP':
        config = { ...this.imap };
        break;
      case 'AZURE_DEVOPS':
        config = { ...this.azdo };
        break;
      case 'MCP_DATABASE':
        config = { ...this.mcp };
        break;
      case 'SLACK':
        config = { ...this.slack };
        break;
    }

    if (this.type === 'MCP_DATABASE') {
      if (config['healthPath'] === null) {
        // Keep null
      } else if (typeof config['healthPath'] === 'string' && (config['healthPath'] as string).length === 0) {
        delete config['healthPath'];
      }
      for (const field of ['mcpPath', 'apiKey']) {
        if (typeof config[field] === 'string' && (config[field] as string).length === 0) {
          delete config[field];
        }
      }
      if (config['authHeader'] === 'bearer') {
        delete config['authHeader'];
      }
      config['disabledTools'] = [...this.disabledTools];
    }

    if (this.editing) {
      for (const field of this.secretFields[this.type] ?? []) {
        if (typeof config[field] === 'string' && (config[field] as string).length === 0) {
          delete config[field];
        }
      }
    }

    const integ = this.integration();
    if (this.editing && integ) {
      this.integrationService.updateIntegration(integ.id, {
        label: this.label || 'default',
        config,
        isActive: this.isActive,
        notes: this.notes || null,
      }).subscribe({
        next: () => {
          this.toast.success('Integration updated');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Update failed'),
      });
    } else {
      this.integrationService.createIntegration({
        clientId: this.clientId(),
        type: this.type,
        label: this.label || 'default',
        config,
        notes: this.notes || undefined,
      }).subscribe({
        next: () => {
          this.toast.success('Integration created');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed'),
      });
    }
  }
}
