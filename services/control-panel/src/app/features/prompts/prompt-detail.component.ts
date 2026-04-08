import { Component, DestroyRef, inject, OnInit, signal, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { PromptService, PromptDetail, PromptOverride, PreviewResult } from '../../core/services/prompt.service';
import { ClientService, Client } from '../../core/services/client.service';
import { OverrideDialogComponent } from './override-dialog.component';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
  SelectComponent,
  ToggleSwitchComponent,
  DialogComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [
    RouterLink,
    BroncoButtonComponent,
    CardComponent,
    FormFieldComponent,
    SelectComponent,
    ToggleSwitchComponent,
    DialogComponent,
    OverrideDialogComponent,
  ],
  template: `
    @if (detail(); as d) {
      <div class="page-wrapper">
        <div class="page-header">
          <div class="header-left">
            <app-bronco-button variant="ghost" size="sm" routerLink="/prompts">&#x2190; AI Prompts</app-bronco-button>
            <h1 class="page-title">{{ d.base.name }}</h1>
          </div>
        </div>

        <div class="prompt-meta">
          <span class="chip chip-task">{{ d.base.taskType }}</span>
          <span class="chip chip-role chip-role-{{ d.base.role.toLowerCase() }}">{{ d.base.role }}</span>
          @if (d.base.temperature !== null) {
            <span class="meta-label">temp: {{ d.base.temperature }}</span>
          }
          @if (d.base.maxTokens !== null) {
            <span class="meta-label">maxTokens: {{ d.base.maxTokens }}</span>
          }
        </div>

        <p class="description">{{ d.base.description }}</p>

        <!-- Base Prompt Content -->
        <app-card padding="md" class="section-card">
          <div class="card-header">
            <div>
              <h2 class="section-title">Base Prompt</h2>
              <p class="section-subtitle">Hardcoded in source — read-only</p>
            </div>
          </div>
          <pre class="prompt-content">{{ d.base.content }}</pre>
        </app-card>

        <!-- Overrides -->
        <div class="section-header">
          <h2 class="section-title">Overrides</h2>
          <app-bronco-button variant="primary" size="sm" (click)="addOverride()">+ Add Override</app-bronco-button>
        </div>

        @if (d.overrides.length > 0) {
          <div class="overrides-list">
            @for (o of d.overrides; track o.id) {
              <app-card padding="sm" class="override-card">
                <div class="override-header">
                  <span class="chip chip-scope chip-scope-{{ o.scope.toLowerCase() }}">{{ o.scope }}</span>
                  <span class="chip chip-position">{{ o.position }}</span>
                  @if (o.client) {
                    <span class="chip chip-code">{{ o.client.shortCode }}</span>
                  }
                  <div class="override-actions">
                    <app-toggle-switch
                      [checked]="o.isActive"
                      (checkedChange)="toggleOverride(o)">
                    </app-toggle-switch>
                    <app-bronco-button variant="icon" size="sm" ariaLabel="Edit override" (click)="editOverride(o)">
                      &#x270E;
                    </app-bronco-button>
                    <app-bronco-button variant="icon" size="sm" ariaLabel="Delete override" class="btn-delete" (click)="deleteOverride(o)">
                      &#x1F5D1;
                    </app-bronco-button>
                  </div>
                </div>
                <pre class="override-content">{{ o.content }}</pre>
              </app-card>
            }
          </div>
        } @else {
          <p class="empty">No overrides for this prompt.</p>
        }

        <!-- Composed Preview -->
        <app-card padding="md" class="section-card preview-card">
          <div class="card-header">
            <h2 class="section-title">Composed Preview</h2>
            <app-bronco-button variant="secondary" size="sm" (click)="loadPreview()">&#x21BB; Refresh</app-bronco-button>
          </div>

          <div class="preview-controls">
            <app-form-field label="Client">
              <app-select
                [value]="selectedClientId"
                [options]="clientOptions()"
                placeholder=""
                (valueChange)="onClientChange($event)">
              </app-select>
            </app-form-field>
          </div>

          @if (preview(); as pv) {
            <pre class="prompt-content">{{ pv.rendered }}</pre>

            @if (pv.placeholders.length > 0) {
              <h3 class="placeholders-title">Placeholders</h3>
              <table class="placeholder-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Label</th>
                    <th>Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  @for (ph of pv.placeholders; track ph.token) {
                    <tr>
                      <td><code class="token-code">{{ wrapToken(ph.token) }}</code></td>
                      <td>{{ ph.label ?? '-' }}</td>
                      <td>{{ ph.resolved ?? '(unresolved)' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          } @else {
            <p class="muted">Click Refresh to preview the composed prompt.</p>
          }
        </app-card>
      </div>
    } @else {
      <div class="page-wrapper">
        <p class="muted">Loading...</p>
      </div>
    }

    @if (showOverrideDialog()) {
      <app-dialog [open]="true" [title]="editingOverride() ? 'Edit Override' : 'Add Override'" maxWidth="600px" (openChange)="showOverrideDialog.set(false)">
        <app-override-dialog-content
          [promptKey]="key()"
          [override]="editingOverride() ?? undefined"
          (saved)="onOverrideSaved()"
          (cancelled)="showOverrideDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .page-wrapper { max-width: 900px; }

    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 16px;
    }
    .header-left { display: flex; flex-direction: column; gap: 4px; }
    .page-title {
      margin: 6px 0 0;
      font-family: var(--font-primary);
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.24px;
      line-height: 1.2;
    }

    .prompt-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
      white-space: nowrap;
    }

    .chip-task {
      background: var(--bg-active);
      color: var(--accent);
    }

    .chip-role-system {
      background: var(--color-info-subtle);
      color: var(--color-info);
    }
    .chip-role-user {
      background: var(--color-success-subtle);
      color: var(--color-success);
    }

    .chip-scope-app_wide {
      background: var(--color-purple-subtle);
      color: var(--color-purple);
    }
    .chip-scope-client {
      background: var(--color-warning-subtle);
      color: var(--color-warning);
    }

    .chip-position {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }

    .chip-code {
      background: var(--bg-active);
      color: var(--accent);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
    }

    .meta-label {
      font-size: 12px;
      color: var(--text-tertiary);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    }

    .description {
      color: var(--text-secondary);
      font-family: var(--font-primary);
      font-size: 14px;
      margin: 0 0 20px;
      line-height: 1.5;
    }

    .section-card { margin-bottom: 20px; }

    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 14px;
      gap: 12px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .section-subtitle {
      margin: 2px 0 0;
      font-family: var(--font-primary);
      font-size: 12px;
      color: var(--text-tertiary);
    }

    .prompt-content {
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--bg-code);
      color: var(--text-code);
      padding: 14px 16px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-light);
      font-size: 12px;
      line-height: 1.6;
      max-height: 420px;
      overflow: auto;
      margin: 0;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    }

    /* Overrides section */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 24px 0 12px;
    }

    .overrides-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }

    .override-card {}

    .override-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }

    .override-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .override-content {
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--color-warning-subtle);
      color: var(--text-primary);
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-light);
      font-size: 12px;
      line-height: 1.5;
      margin: 0;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    }

    .empty {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 14px;
      padding: 20px 0;
      text-align: center;
      margin: 0 0 20px;
    }

    /* Preview section */
    .preview-card {}

    .preview-controls { margin-bottom: 14px; max-width: 320px; }

    .placeholders-title {
      margin: 16px 0 8px;
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .placeholder-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      font-family: var(--font-primary);
    }
    .placeholder-table th,
    .placeholder-table td {
      text-align: left;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border-light);
      color: var(--text-primary);
    }
    .placeholder-table th {
      font-weight: 600;
      color: var(--text-secondary);
      background: var(--bg-muted);
      font-size: 12px;
    }
    .placeholder-table tr:last-child td { border-bottom: none; }

    .token-code {
      font-size: 12px;
      background: var(--bg-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      color: var(--text-primary);
    }

    .muted {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 14px;
      margin: 0;
    }
  `],
})
export class PromptDetailComponent implements OnInit {
  key = input.required<string>();

  private promptService = inject(PromptService);
  private clientService = inject(ClientService);
  private destroyRef = inject(DestroyRef);
  private toast = inject(ToastService);

  detail = signal<PromptDetail | null>(null);
  preview = signal<PreviewResult | null>(null);
  clients = signal<Client[]>([]);
  selectedClientId = '';

  showOverrideDialog = signal(false);
  editingOverride = signal<PromptOverride | null>(null);

  clientOptions = signal<Array<{ value: string; label: string }>>([
    { value: '', label: 'No client (APP_WIDE only)' },
  ]);

  ngOnInit(): void {
    this.load();
    this.clientService.getClients().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(clients => {
      this.clients.set(clients);
      this.clientOptions.set([
        { value: '', label: 'No client (APP_WIDE only)' },
        ...clients.map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
      ]);
    });
  }

  wrapToken(token: string): string {
    return `{{${token}}}`;
  }

  load(): void {
    this.promptService.getPrompt(this.key(), this.selectedClientId || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(d => {
        this.detail.set(d);
        this.preview.set(null);
      });
  }

  onClientChange(clientId: string): void {
    this.selectedClientId = clientId;
    this.loadPreview();
  }

  loadPreview(): void {
    this.promptService.previewPrompt({
      promptKey: this.key(),
      clientId: this.selectedClientId || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(pv => this.preview.set(pv));
  }

  addOverride(): void {
    this.editingOverride.set(null);
    this.showOverrideDialog.set(true);
  }

  editOverride(override: PromptOverride): void {
    this.editingOverride.set(override);
    this.showOverrideDialog.set(true);
  }

  onOverrideSaved(): void {
    this.showOverrideDialog.set(false);
    this.load();
  }

  toggleOverride(override: PromptOverride): void {
    this.promptService.updateOverride(override.id, { isActive: !override.isActive }).subscribe({
      next: () => {
        this.toast.success(`Override ${override.isActive ? 'deactivated' : 'activated'}`);
        this.load();
      },
      error: () => this.toast.error('Failed to update override'),
    });
  }

  deleteOverride(override: PromptOverride): void {
    if (!confirm('Delete this override?')) return;
    this.promptService.deleteOverride(override.id).subscribe({
      next: () => {
        this.toast.success('Override deleted');
        this.load();
      },
      error: () => this.toast.error('Failed to delete override'),
    });
  }
}
