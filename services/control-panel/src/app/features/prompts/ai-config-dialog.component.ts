import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiConfigService, AiModelConfig } from '../../core/services/ai-config.service';
import { ClientService, Client } from '../../core/services/client.service';
import { AiUsageService, CatalogModel } from '../../core/services/ai-usage.service';
import { AiProviderService, ProviderType } from '../../core/services/ai-provider.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-ai-config-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent],
  template: `
    @if (isEdit && codeDefaultVal) {
      <div class="code-default-info">
        <span class="info-label">Code default:</span>
        <span class="info-value">{{ codeDefaultVal.provider }} / {{ codeDefaultVal.model }}</span>
      </div>
    }

    <div class="form-grid">
      @if (isEdit || presetTaskType()) {
        <div class="field-label">
          <span class="info-label">Task Type</span>
          <span class="code-chip">{{ taskType }}</span>
        </div>
      } @else {
        <app-form-field label="Task Type">
          <app-select
            [value]="taskType"
            [options]="taskTypeOptions"
            (valueChange)="taskType = $event" />
        </app-form-field>
      }

      <app-form-field label="Scope">
        <app-select
          [value]="scope"
          [options]="scopeOptions"
          [disabled]="isEdit"
          (valueChange)="scope = $event; onScopeChange()" />
      </app-form-field>

      @if (scope === 'CLIENT') {
        <app-form-field label="Client">
          <app-select
            [value]="clientId"
            [options]="clientOptions"
            [disabled]="isEdit"
            (valueChange)="clientId = $event" />
        </app-form-field>
      }

      <app-form-field label="Provider">
        <app-select
          [value]="provider"
          [options]="providerOptions"
          [disabled]="loadingProviders"
          (valueChange)="provider = $event; onProviderChange()" />
      </app-form-field>

      @if (modelsForProvider.length > 0) {
        <app-form-field label="Model">
          <app-select
            [value]="model"
            [options]="modelOptions"
            (valueChange)="model = $event" />
        </app-form-field>
      } @else {
        <app-form-field label="Model">
          <app-text-input
            [value]="model"
            placeholder="e.g. llama3.1:8b or claude-sonnet-4-6"
            (valueChange)="model = $event" />
        </app-form-field>
      }

      <app-form-field label="Max Tokens (optional)">
        <app-text-input
          [value]="maxTokensStr"
          placeholder="e.g. 4096, 8192 — leave blank for provider default"
          (valueChange)="maxTokensStr = $event" />
      </app-form-field>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!canSave()" (click)="save()">
        {{ isEdit ? 'Update' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .code-default-info { display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin-bottom: 12px; background: var(--bg-muted); border-radius: 4px; border-left: 3px solid var(--text-tertiary); font-size: 13px; }
    .info-label { font-weight: 600; color: var(--text-tertiary); }
    .info-value { font-family: monospace; color: var(--text-primary); }
    .field-label { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .code-chip { font-size: 12px; padding: 2px 8px; background: var(--color-info-subtle); border-radius: 4px; color: var(--color-info); font-family: monospace; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class AiConfigDialogComponent implements OnInit {
  private aiConfigService = inject(AiConfigService);
  private clientService = inject(ClientService);
  private aiUsageService = inject(AiUsageService);
  private aiProviderService = inject(AiProviderService);
  private toast = inject(ToastService);

  config = input<AiModelConfig>();
  presetTaskType = input<string>();
  taskTypes = input<string[]>([]);
  codeDefault = input<{ provider: string; model: string }>();

  saved = output<AiModelConfig>();
  cancelled = output<void>();

  scopeOptions = [
    { value: 'APP_WIDE', label: 'APP_WIDE (system-wide)' },
    { value: 'CLIENT', label: 'CLIENT (per-client)' },
  ];

  isEdit = false;
  taskType = '';
  scope = 'APP_WIDE';
  clientId = '';
  provider = '';
  model = '';
  maxTokensStr = '';
  clients: Client[] = [];
  taskTypesList: string[] = [];
  codeDefaultVal: { provider: string; model: string } | null = null;

  loadingProviders = true;
  providerTypes: ProviderType[] = [];
  private catalogMap = new Map<string, CatalogModel[]>();
  modelsForProvider: CatalogModel[] = [];

  get taskTypeOptions(): Array<{ value: string; label: string }> {
    return this.taskTypesList.map(tt => ({ value: tt, label: tt }));
  }

  get clientOptions(): Array<{ value: string; label: string }> {
    return [
      { value: '', label: 'Select client...' },
      ...this.clients.map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
    ];
  }

  get providerOptions(): Array<{ value: string; label: string }> {
    return [
      { value: '', label: 'Select provider...' },
      ...this.providerTypes
        .filter(p => p.routable || (this.isEdit && p.value === this.provider))
        .map(p => ({ value: p.value, label: p.label })),
    ];
  }

  get modelOptions(): Array<{ value: string; label: string }> {
    return this.modelsForProvider.map(m => ({ value: m.model, label: m.displayName || m.model }));
  }

  ngOnInit(): void {
    const cfg = this.config();
    this.isEdit = !!cfg;
    this.taskType = cfg?.taskType ?? this.presetTaskType() ?? '';
    this.scope = cfg?.scope ?? 'APP_WIDE';
    this.clientId = cfg?.clientId ?? '';
    this.provider = cfg?.provider ?? '';
    this.model = cfg?.model ?? '';
    this.maxTokensStr = cfg?.maxTokens != null ? String(cfg.maxTokens) : '';
    this.taskTypesList = this.taskTypes() ?? [];
    this.codeDefaultVal = this.codeDefault() ?? null;

    if (this.scope === 'CLIENT' || !this.isEdit) {
      this.clientService.getClients().subscribe(c => this.clients = c);
    }

    this.aiProviderService.getTypes().subscribe({
      next: (types) => {
        this.providerTypes = types;
        if (this.provider && !types.some(t => t.value === this.provider)) {
          this.providerTypes = [{ value: this.provider, label: this.provider, routable: false }, ...types];
        }
        this.loadingProviders = false;
      },
      error: () => {
        this.loadingProviders = false;
        this.toast.error('Failed to load provider types');
      },
    });

    this.aiUsageService.getCatalog().subscribe(catalog => {
      for (const p of catalog.providers) {
        this.catalogMap.set(p.provider, p.models);
      }
      this.updateModelsForProvider();
    });
  }

  onProviderChange(): void {
    this.updateModelsForProvider();
    if (!this.isEdit) {
      this.model = '';
    }
  }

  onScopeChange(): void {
    if (this.scope === 'APP_WIDE') {
      this.clientId = '';
    } else if (this.clients.length === 0) {
      this.clientService.getClients().subscribe(c => this.clients = c);
    }
  }

  private updateModelsForProvider(): void {
    this.modelsForProvider = this.catalogMap.get(this.provider) ?? [];
    if (this.model && !this.modelsForProvider.some(m => m.model === this.model)) {
      this.modelsForProvider = [{ model: this.model, displayName: this.model, contextLength: null, maxCompletionTokens: null, modality: null }, ...this.modelsForProvider];
    }
  }

  private get parsedMaxTokens(): number | null {
    const trimmed = this.maxTokensStr.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }

  canSave(): boolean {
    if (!this.taskType || !this.provider || !this.model.trim()) return false;
    if (this.scope === 'CLIENT' && !this.clientId) return false;
    if (this.maxTokensStr.trim() !== '' && this.parsedMaxTokens === null) return false;
    return true;
  }

  save(): void {
    if (this.isEdit) {
      this.aiConfigService.update(this.config()!.id, {
        provider: this.provider,
        model: this.model.trim(),
        maxTokens: this.parsedMaxTokens,
      }).subscribe({
        next: (result) => {
          this.toast.success('Config updated');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to update config'),
      });
    } else {
      this.aiConfigService.create({
        taskType: this.taskType,
        scope: this.scope,
        clientId: this.scope === 'CLIENT' ? this.clientId : undefined,
        provider: this.provider,
        model: this.model.trim(),
        maxTokens: this.parsedMaxTokens,
      }).subscribe({
        next: (result) => {
          this.toast.success('Config created');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to create config'),
      });
    }
  }
}
