import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar } from '@angular/material/snack-bar';
import { IntegrationService } from '../../core/services/integration.service';
import type { ClientIntegration } from '../../core/services/integration.service';
import { AuthService } from '../../core/services/auth.service';

interface DialogData {
  clientId: string;
  integration?: ClientIntegration;
}

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatSlideToggleModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ editing ? 'Edit' : 'Add' }} Integration</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Type</mat-label>
        <mat-select [(ngModel)]="type" (ngModelChange)="onTypeChange()" [disabled]="editing">
          <mat-option value="IMAP">IMAP (Email)</mat-option>
          <mat-option value="AZURE_DEVOPS">Azure DevOps</mat-option>
          <mat-option value="MCP_DATABASE">MCP Database</mat-option>
          <mat-option value="SLACK">Slack</mat-option>
        </mat-select>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Label</mat-label>
        <input matInput [(ngModel)]="label" placeholder="e.g. prod, dev, staging">
        <mat-hint>Allows multiple integrations of the same type per client</mat-hint>
      </mat-form-field>

      @if (type === 'IMAP') {
        @if (imapLoopWarning) {
          <div class="loop-warning">
            <strong>Warning:</strong> This inbox email matches your login email ({{ currentUserEmail }}).
            Automated replies sent to this address will be ingested as new tickets, creating an email loop.
            Use a separate email address for ticket ingestion.
          </div>
        }
        <mat-form-field class="full-width">
          <mat-label>IMAP Host</mat-label>
          <input matInput [(ngModel)]="imap.host" placeholder="imap.gmail.com">
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>IMAP Port</mat-label>
          <input matInput type="number" [(ngModel)]="imap.port">
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>User</mat-label>
          <input matInput [(ngModel)]="imap.user" (ngModelChange)="checkImapLoop()">
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Password</mat-label>
          <input matInput type="password" [(ngModel)]="imap.encryptedPassword" [placeholder]="editing ? '(unchanged)' : ''">
          @if (editing) {
            <mat-hint>Leave blank to keep existing password</mat-hint>
          }
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Poll Interval (seconds)</mat-label>
          <input matInput type="number" [(ngModel)]="imap.pollIntervalSeconds">
        </mat-form-field>
      }

      @if (type === 'AZURE_DEVOPS') {
        <mat-form-field class="full-width">
          <mat-label>Organization URL</mat-label>
          <input matInput [(ngModel)]="azdo.orgUrl" placeholder="https://dev.azure.com/org">
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Project</mat-label>
          <input matInput [(ngModel)]="azdo.project">
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Personal Access Token</mat-label>
          <input matInput type="password" [(ngModel)]="azdo.encryptedPat" [placeholder]="editing ? '(unchanged)' : ''">
          @if (editing) {
            <mat-hint>Leave blank to keep existing token</mat-hint>
          }
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Assigned User</mat-label>
          <input matInput [(ngModel)]="azdo.assignedUser">
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Poll Interval (seconds)</mat-label>
          <input matInput type="number" [(ngModel)]="azdo.pollIntervalSeconds">
        </mat-form-field>
      }

      @if (type === 'MCP_DATABASE') {
        <mat-form-field class="full-width">
          <mat-label>MCP Database URL</mat-label>
          <input matInput [(ngModel)]="mcp.url" placeholder="mcp-db.example.com:3100">
          <mat-hint>https:// will be added automatically if omitted</mat-hint>
        </mat-form-field>

        @if (showAdvanced) {
          <mat-form-field class="full-width">
            <mat-label>Health Path</mat-label>
            <input
              matInput
              [ngModel]="mcp.healthPath === null ? '' : mcp.healthPath"
              (ngModelChange)="mcp.healthPath = $event === '' ? (editing ? null : '') : $event"
              placeholder="/health">
            <mat-hint>{{ editing ? 'Leave blank to disable health checks' : 'Default: /health' }}. Enter a custom path to override.</mat-hint>
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>MCP Path</mat-label>
            <input matInput [(ngModel)]="mcp.mcpPath" placeholder="/mcp">
            <mat-hint>Streamable HTTP endpoint for MCP protocol calls</mat-hint>
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>API Key</mat-label>
            <input matInput type="password" [(ngModel)]="mcp.apiKey" [placeholder]="editing ? '(unchanged)' : '(optional)'">
            @if (editing) {
              <mat-hint>Leave blank to keep existing key</mat-hint>
            }
          </mat-form-field>
          <mat-form-field class="full-width">
            <mat-label>Auth Header</mat-label>
            <mat-select [(ngModel)]="mcp.authHeader">
              <mat-option value="bearer">Authorization: Bearer (default)</mat-option>
              <mat-option value="x-api-key">x-api-key</mat-option>
            </mat-select>
            <mat-hint>How the API key is sent to the MCP server</mat-hint>
          </mat-form-field>
        }

        <button mat-button type="button" (click)="showAdvanced = !showAdvanced" class="advanced-toggle">
          {{ showAdvanced ? 'Hide' : 'Show' }} advanced options
        </button>

        @if (discoveredTools.length > 0) {
          <div class="tool-visibility-section">
            <h4 class="tool-heading">Tool Visibility for Agentic Analysis</h4>
            <p class="tool-hint">Uncheck tools to hide them from the AI during agentic analysis.</p>
            @for (tool of discoveredTools; track tool.name) {
              <mat-checkbox
                [checked]="!disabledTools.has(tool.name)"
                (change)="toggleTool(tool.name, $event.checked)">
                <span class="tool-name">{{ tool.name }}</span>
                @if (tool.description) {
                  <span class="tool-desc"> — {{ tool.description }}</span>
                }
              </mat-checkbox>
            }
          </div>
        }
      }

      @if (type === 'SLACK') {
        <mat-form-field class="full-width">
          <mat-label>Bot Token</mat-label>
          <input matInput type="password" [(ngModel)]="slack.encryptedBotToken" [placeholder]="editing ? '(unchanged)' : 'xoxb-...'">
          @if (editing) {
            <mat-hint>Leave blank to keep existing token</mat-hint>
          }
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>App-Level Token</mat-label>
          <input matInput type="password" [(ngModel)]="slack.encryptedAppToken" [placeholder]="editing ? '(unchanged)' : 'xapp-...'">
          @if (editing) {
            <mat-hint>Leave blank to keep existing token</mat-hint>
          }
        </mat-form-field>
        <mat-form-field class="full-width">
          <mat-label>Default Channel ID</mat-label>
          <input matInput [(ngModel)]="slack.defaultChannelId" placeholder="C0123456789">
          <mat-hint>Channel where ticket updates are posted</mat-hint>
        </mat-form-field>
        <mat-slide-toggle [(ngModel)]="slack.enabled">{{ slack.enabled ? 'Enabled' : 'Disabled' }}</mat-slide-toggle>
      }

      <mat-form-field class="full-width">
        <mat-label>Notes</mat-label>
        <textarea matInput [(ngModel)]="notes" rows="2"></textarea>
      </mat-form-field>

      @if (editing) {
        <mat-slide-toggle [(ngModel)]="isActive">{{ isActive ? 'Active' : 'Inactive' }}</mat-slide-toggle>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!type">{{ editing ? 'Save' : 'Create' }}</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .advanced-toggle { font-size: 13px; color: #666; margin-bottom: 8px; }
    .loop-warning { background: #fff3e0; border: 1px solid #ff9800; border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; color: #e65100; line-height: 1.4; }
    .tool-visibility-section { margin-top: 12px; border-top: 1px solid #e0e0e0; padding-top: 12px; }
    .tool-heading { font-size: 14px; font-weight: 500; margin: 0 0 4px; color: #333; }
    .tool-hint { font-size: 12px; color: #777; margin: 0 0 8px; }
    .tool-visibility-section mat-checkbox { display: block; margin-bottom: 4px; }
    .tool-name { font-weight: 500; font-size: 13px; }
    .tool-desc { font-size: 12px; color: #666; }
  `],
})
export class IntegrationDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<IntegrationDialogComponent>);
  private data: DialogData = inject(MAT_DIALOG_DATA);
  private integrationService = inject(IntegrationService);
  private authService = inject(AuthService);
  private snackBar = inject(MatSnackBar);

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

  /** Secret fields that should be blanked when editing (so the encrypted value isn't shown). */
  private readonly secretFields: Record<string, string[]> = {
    IMAP: ['encryptedPassword'],
    AZURE_DEVOPS: ['encryptedPat'],
    MCP_DATABASE: ['apiKey'],
    SLACK: ['encryptedBotToken', 'encryptedAppToken'],
  };

  ngOnInit(): void {
    this.currentUserEmail = this.authService.currentUser()?.email ?? '';

    if (this.data.integration) {
      const integ = this.data.integration;
      this.editing = true;
      this.type = integ.type;
      this.label = integ.label;
      this.notes = integ.notes ?? '';
      this.isActive = integ.isActive;

      const config = { ...integ.config };
      // Blank secret fields so encrypted ciphertext isn't displayed
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
          // Show advanced fields if any were previously configured
          if (config['healthPath'] !== undefined || config['mcpPath'] || config['apiKey'] || config['authHeader']) {
            this.showAdvanced = true;
          }
          // Load discovered tools from metadata
          if (integ.metadata?.tools) {
            this.discoveredTools = integ.metadata.tools;
          }
          // Load disabled tools from config
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
    // Reset config forms to defaults when type changes
    this.imap = { host: 'imap.gmail.com', port: 993, user: '', encryptedPassword: '', pollIntervalSeconds: 60 };
    this.azdo = { orgUrl: '', project: '', encryptedPat: '', assignedUser: '', pollIntervalSeconds: 120 };
    this.mcp = { url: '', healthPath: '', mcpPath: '', apiKey: '', authHeader: 'bearer' };
    this.slack = { encryptedBotToken: '', encryptedAppToken: '', defaultChannelId: '', enabled: true };
    this.showAdvanced = false;
    this.discoveredTools = [];
    this.disabledTools = new Set();
  }

  toggleTool(name: string, enabled: boolean): void {
    if (enabled) {
      this.disabledTools.delete(name);
    } else {
      this.disabledTools.add(name);
    }
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

    // Handle MCP optional fields: healthPath=null means "disable health checks",
    // empty mcpPath/apiKey means "use default / none" so delete them.
    if (this.type === 'MCP_DATABASE') {
      // healthPath: null disables health checks, omitted means use default
      if (config['healthPath'] === null) {
        // Keep null — signals "disable health checks"
      } else if (typeof config['healthPath'] === 'string' && (config['healthPath'] as string).length === 0) {
        delete config['healthPath'];
      }
      for (const field of ['mcpPath', 'apiKey']) {
        if (typeof config[field] === 'string' && (config[field] as string).length === 0) {
          delete config[field];
        }
      }
      // Strip default authHeader to keep config clean
      if (config['authHeader'] === 'bearer') {
        delete config['authHeader'];
      }
      // Always send disabledTools (even as empty array) so the backend merge can clear it
      config['disabledTools'] = [...this.disabledTools];
    }

    // When editing, strip blank secret fields so the backend keeps the existing encrypted value
    if (this.editing) {
      for (const field of this.secretFields[this.type] ?? []) {
        if (typeof config[field] === 'string' && (config[field] as string).length === 0) {
          delete config[field];
        }
      }
    }

    if (this.editing) {
      this.integrationService.updateIntegration(this.data.integration!.id, {
        label: this.label || 'default',
        config,
        isActive: this.isActive,
        notes: this.notes || null,
      }).subscribe({
        next: () => {
          this.snackBar.open('Integration updated', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.message ?? 'Update failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    } else {
      this.integrationService.createIntegration({
        clientId: this.data.clientId,
        type: this.type,
        label: this.label || 'default',
        config,
        notes: this.notes || undefined,
      }).subscribe({
        next: () => {
          this.snackBar.open('Integration created', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
          this.dialogRef.close(true);
        },
        error: (err) => this.snackBar.open(err.error?.message ?? 'Failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
      });
    }
  }
}
