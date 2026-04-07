import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { AiProviderService, AiProvider, AiProviderModel } from '../../core/services/ai-provider.service';
import { AiProviderDialogComponent } from '../prompts/ai-provider-dialog.component';
import { AiModelDialogComponent } from '../prompts/ai-model-dialog.component';
import {
  BroncoButtonComponent,
  ToggleSwitchComponent,
  DataTableComponent,
  DataTableColumnComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, BroncoButtonComponent, ToggleSwitchComponent, DataTableComponent, DataTableColumnComponent],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1>AI Providers & Models</h1>
      </div>

      <!-- Providers Section -->
      <div class="section-header">
        <h2>Providers</h2>
        <app-bronco-button variant="primary" (click)="addProvider()">+ Add Provider</app-bronco-button>
      </div>

      <div class="section-card">
        <app-data-table [data]="providers()" [trackBy]="trackProviderById" [rowClickable]="false" emptyMessage="No providers configured. Add a provider to get started.">
          <app-data-column key="provider" header="Provider" [sortable]="false">
            <ng-template #cell let-p>
              <span class="provider-chip provider-{{ p.provider.toLowerCase() }}">{{ p.provider }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="baseUrl" header="Base URL" [sortable]="false">
            <ng-template #cell let-p>
              @if (p.baseUrl) {
                <code class="url-text">{{ p.baseUrl }}</code>
              } @else {
                <span class="muted">—</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="apiKey" header="API Key" [sortable]="false" width="80px">
            <ng-template #cell let-p>
              @if (p.hasApiKey) {
                <span class="key-icon" title="API key configured">&#x1F512;</span>
              } @else {
                <span class="muted">—</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="models" header="Models" [sortable]="false" width="80px">
            <ng-template #cell let-p>
              <span class="code-chip">{{ p.activeModelCount }}/{{ p.modelCount }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="active" header="Active" [sortable]="false" width="80px">
            <ng-template #cell let-p>
              <app-toggle-switch
                [checked]="p.isActive"
                (checkedChange)="toggleProviderActive(p)">
              </app-toggle-switch>
            </ng-template>
          </app-data-column>

          <app-data-column key="actions" header="" [sortable]="false" width="140px">
            <ng-template #cell let-p>
              <div class="action-btns">
                <app-bronco-button variant="ghost" size="sm" title="Test Connection" (click)="testProvider(p)">Test</app-bronco-button>
                <app-bronco-button variant="ghost" size="sm" (click)="editProvider(p)">Edit</app-bronco-button>
                <app-bronco-button variant="destructive" size="sm" title="Delete provider and all its models" (click)="deleteProvider(p)">Delete</app-bronco-button>
              </div>
            </ng-template>
          </app-data-column>
        </app-data-table>
      </div>

      <!-- Models Section -->
      <div class="section-header models-section">
        <h2>Models</h2>
        <app-bronco-button variant="primary" (click)="addModel()" [disabled]="providers().length === 0">+ Add Model</app-bronco-button>
      </div>

      @if (disabledProviderTypes().length > 0) {
        <div class="provider-warning-banner">
          <span class="warning-icon">&#x26A0;</span>
          <span>
            @for (p of disabledProviderTypes(); track p; let last = $last) {
              <strong>{{ p }}</strong>{{ last ? '' : ', ' }}
            }
            {{ disabledProviderTypes().length > 1 ? 'providers are' : 'provider is' }} unavailable (disabled or with no active models).
            Models under these providers will not be routed to.
          </span>
        </div>
      }

      <div class="section-card">
        <app-data-table [data]="models()" [trackBy]="trackModelById" [rowClickable]="false" emptyMessage="No models configured. Add a model to enable AI features.">
          <app-data-column key="name" header="Name" [sortable]="false">
            <ng-template #cell let-m>
              <span class="model-name-text">{{ m.name }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="provider" header="Provider" [sortable]="false">
            <ng-template #cell let-m>
              <span class="provider-chip provider-{{ m.provider.toLowerCase() }}">{{ m.provider }}</span>
              @if (!m.providerActive) {
                <span class="inline-warn" title="Provider is disabled">&#x26A0;</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="model" header="Model" [sortable]="false">
            <ng-template #cell let-m>
              <code class="model-code">{{ m.model }}</code>
            </ng-template>
          </app-data-column>

          <app-data-column key="capability" header="Capability" [sortable]="false">
            <ng-template #cell let-m>
              <span class="code-chip">{{ m.capabilityLevel }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="enabledApps" header="Enabled For" [sortable]="false">
            <ng-template #cell let-m>
              @if (m.enabledApps.length === 0) {
                <span class="scope-chip scope-all">All Apps</span>
              } @else {
                @for (app of m.enabledApps; track app) {
                  <span class="scope-chip">{{ appScopeLabel(app) }}</span>
                }
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="active" header="Active" [sortable]="false" width="80px">
            <ng-template #cell let-m>
              <app-toggle-switch
                [checked]="m.isActive"
                (checkedChange)="toggleModelActive(m)">
              </app-toggle-switch>
            </ng-template>
          </app-data-column>

          <app-data-column key="actions" header="" [sortable]="false" width="120px">
            <ng-template #cell let-m>
              <div class="action-btns">
                <app-bronco-button variant="ghost" size="sm" (click)="editModel(m)">Edit</app-bronco-button>
                <app-bronco-button variant="destructive" size="sm" (click)="deleteModel(m)">Delete</app-bronco-button>
              </div>
            </ng-template>
          </app-data-column>
        </app-data-table>
      </div>
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .page-header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
      font-family: var(--font-primary);
      color: var(--text-primary);
      letter-spacing: -0.28px;
      line-height: 1.14;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .section-header h2 {
      margin: 0;
      font-size: 21px;
      font-weight: 600;
      font-family: var(--font-primary);
      color: var(--text-primary);
      letter-spacing: -0.224px;
    }
    .section-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      margin-bottom: 24px;
      overflow: hidden;
    }
    .models-section { margin-top: 32px; }
    .provider-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-muted);
      color: var(--text-secondary);
      font-family: var(--font-primary);
    }
    .provider-local { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .provider-claude { background: rgba(255, 59, 48, 0.08); color: var(--color-error); }
    .provider-openai { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .provider-grok { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .provider-google { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .url-text {
      font-size: 12px;
      background: var(--bg-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      word-break: break-all;
    }
    .model-code {
      font-size: 13px;
      background: var(--bg-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }
    .model-name-text {
      font-weight: 500;
      color: var(--text-primary);
      font-family: var(--font-primary);
    }
    .code-chip {
      font-size: 12px;
      padding: 2px 8px;
      background: rgba(0, 113, 227, 0.08);
      border-radius: var(--radius-sm);
      color: var(--accent);
      font-family: monospace;
    }
    .key-icon { font-size: 14px; }
    .muted { color: var(--text-tertiary); }
    .action-btns { display: flex; gap: 4px; align-items: center; }
    .provider-warning-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      margin-bottom: 16px;
      background: rgba(255, 149, 0, 0.08);
      border: 1px solid rgba(255, 149, 0, 0.2);
      border-radius: var(--radius-md);
      color: var(--color-warning);
      font-size: 13px;
      font-family: var(--font-primary);
    }
    .warning-icon { font-size: 16px; flex-shrink: 0; }
    .scope-chip {
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: rgba(0, 113, 227, 0.08);
      color: var(--accent);
      margin-right: 4px;
      display: inline-block;
      margin-bottom: 2px;
    }
    .scope-all { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .inline-warn {
      font-size: 14px;
      color: var(--color-warning);
      vertical-align: middle;
      margin-left: 4px;
    }
  `],
})
export class AiProvidersComponent implements OnInit {
  private aiProviderService = inject(AiProviderService);
  private dialog = inject(MatDialog);
  private toast = inject(ToastService);

  providers = signal<AiProvider[]>([]);
  models = signal<AiProviderModel[]>([]);

  private appScopeLabels = signal<Record<string, string>>({});

  trackProviderById = (p: AiProvider) => p.id;
  trackModelById = (m: AiProviderModel) => m.id;

  appScopeLabel(scope: string): string {
    return this.appScopeLabels()[scope] ?? scope;
  }

  disabledProviderTypes = computed(() => {
    return this.providers().filter((p) => !p.isActive || p.activeModelCount === 0).map((p) => p.provider);
  });

  ngOnInit(): void {
    this.loadAll();
    this.aiProviderService.getAppScopes().subscribe((scopes) => {
      const map: Record<string, string> = {};
      for (const s of scopes) map[s.value] = s.label;
      this.appScopeLabels.set(map);
    });
  }

  loadAll(): void {
    this.aiProviderService.listProviders().subscribe(providers => this.providers.set(providers));
    this.aiProviderService.listModels().subscribe(models => this.models.set(models));
  }

  // --- Provider actions ---

  addProvider(): void {
    const ref = this.dialog.open(AiProviderDialogComponent, { width: '500px', data: {} });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  editProvider(config: AiProvider): void {
    const ref = this.dialog.open(AiProviderDialogComponent, { width: '500px', data: { config } });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  toggleProviderActive(config: AiProvider): void {
    this.aiProviderService.updateProvider(config.id, { isActive: !config.isActive }).subscribe({
      next: () => {
        this.toast.success(`Provider ${config.isActive ? 'deactivated' : 'activated'}`);
        this.loadAll();
      },
      error: () => this.toast.error('Failed to update provider'),
    });
  }

  testProvider(config: AiProvider): void {
    this.toast.info('Testing connection...');
    this.aiProviderService.testConnection(config.id).subscribe({
      next: (result) => {
        if (result.success) {
          this.toast.success(result.note ?? 'Connection successful');
        } else {
          this.toast.error(result.error ?? 'Connection failed');
        }
      },
      error: (err) => this.toast.error(err.error?.message ?? 'Test failed'),
    });
  }

  deleteProvider(config: AiProvider): void {
    const modelWarning = config.modelCount > 0 ? ` This will also delete ${config.modelCount} model(s).` : '';
    if (!confirm(`Delete provider "${config.provider}"?${modelWarning}`)) return;
    this.aiProviderService.deleteProvider(config.id).subscribe({
      next: () => { this.toast.success('Provider deleted'); this.loadAll(); },
      error: () => this.toast.error('Failed to delete provider'),
    });
  }

  // --- Model actions ---

  addModel(): void {
    const ref = this.dialog.open(AiModelDialogComponent, { width: '500px', data: { providers: this.providers() } });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  editModel(model: AiProviderModel): void {
    const ref = this.dialog.open(AiModelDialogComponent, { width: '500px', data: { model, providers: this.providers() } });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  toggleModelActive(model: AiProviderModel): void {
    this.aiProviderService.updateModel(model.id, { isActive: !model.isActive }).subscribe({
      next: () => {
        this.toast.success(`Model ${model.isActive ? 'deactivated' : 'activated'}`);
        this.loadAll();
      },
      error: () => this.toast.error('Failed to update model'),
    });
  }

  deleteModel(model: AiProviderModel): void {
    if (!confirm(`Delete model "${model.name}"?`)) return;
    this.aiProviderService.deleteModel(model.id).subscribe({
      next: () => { this.toast.success('Model deleted'); this.loadAll(); },
      error: () => this.toast.error('Failed to delete model'),
    });
  }
}
