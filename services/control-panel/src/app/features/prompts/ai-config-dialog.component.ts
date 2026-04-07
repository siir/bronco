import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { AiConfigService, AiModelConfig } from '../../core/services/ai-config.service';
import { ClientService, Client } from '../../core/services/client.service';
import { AiUsageService, CatalogModel } from '../../core/services/ai-usage.service';
import { AiProviderService, ProviderType } from '../../core/services/ai-provider.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-ai-config-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    @if (isEdit && codeDefaultVal) {
      <div class="code-default-info">
        <span class="info-label">Code default:</span>
        <span class="info-value">{{ codeDefaultVal.provider }} / {{ codeDefaultVal.model }}</span>
      </div>
    }
    @if (isEdit || presetTaskType()) {
      <div class="field-label">
        <span class="info-label">Task Type</span>
        <span class="code-chip">{{ taskType }}</span>
      </div>
    } @else {
      <mat-form-field class="full-width">
        <mat-label>Task Type</mat-label>
        <mat-select [(ngModel)]="taskType" required>
          @for (tt of taskTypesList; track tt) {
            <mat-option [value]="tt">{{ tt }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }

    <mat-form-field class="full-width">
      <mat-label>Scope</mat-label>
      <mat-select [(ngModel)]="scope" [disabled]="isEdit" (ngModelChange)="onScopeChange()">
        <mat-option value="APP_WIDE">APP_WIDE (system-wide)</mat-option>
        <mat-option value="CLIENT">CLIENT (per-client)</mat-option>
      </mat-select>
    </mat-form-field>

    @if (scope === 'CLIENT') {
      <mat-form-field class="full-width">
        <mat-label>Client</mat-label>
        <mat-select [(ngModel)]="clientId" [disabled]="isEdit" required>
          @for (c of clients; track c.id) {
            <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }

    <mat-form-field class="full-width">
      <mat-label>Provider</mat-label>
      <mat-select [(ngModel)]="provider" required (ngModelChange)="onProviderChange()">
        @if (loadingProviders) {
          <mat-option disabled>Loading providers...</mat-option>
        }
        @for (p of providerTypes; track p.value) {
          <mat-option [value]="p.value" [disabled]="!p.routable">{{ p.label }}{{ p.routable ? '' : ' (not yet supported)' }}</mat-option>
        }
      </mat-select>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Model</mat-label>
      @if (modelsForProvider.length > 0) {
        <mat-select [(ngModel)]="model" required>
          @for (m of modelsForProvider; track m.model) {
            <mat-option [value]="m.model">{{ m.displayName || m.model }}</mat-option>
          }
        </mat-select>
      } @else {
        <input matInput [(ngModel)]="model" required placeholder="e.g. llama3.1:8b or claude-sonnet-4-6">
      }
    </mat-form-field>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .code-default-info { display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin-bottom: 12px; background: #f5f5f5; border-radius: 4px; border-left: 3px solid #9e9e9e; font-size: 13px; }
    .info-label { font-weight: 600; color: #666; }
    .info-value { font-family: monospace; color: #333; }
    .field-label { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .code-chip { font-size: 12px; padding: 2px 8px; background: #e8eaf6; border-radius: 4px; color: #3f51b5; font-family: monospace; }
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

  isEdit = false;
  taskType = '';
  scope = 'APP_WIDE';
  clientId = '';
  provider = '';
  model = '';
  clients: Client[] = [];
  taskTypesList: string[] = [];
  codeDefaultVal: { provider: string; model: string } | null = null;

  loadingProviders = true;
  providerTypes: ProviderType[] = [];
  private catalogMap = new Map<string, CatalogModel[]>();
  modelsForProvider: CatalogModel[] = [];

  ngOnInit(): void {
    const cfg = this.config();
    this.isEdit = !!cfg;
    this.taskType = cfg?.taskType ?? this.presetTaskType() ?? '';
    this.scope = cfg?.scope ?? 'APP_WIDE';
    this.clientId = cfg?.clientId ?? '';
    this.provider = cfg?.provider ?? '';
    this.model = cfg?.model ?? '';
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

  canSave(): boolean {
    if (!this.taskType || !this.provider || !this.model.trim()) return false;
    if (this.scope === 'CLIENT' && !this.clientId) return false;
    return true;
  }

  save(): void {
    if (this.isEdit) {
      this.aiConfigService.update(this.config()!.id, {
        provider: this.provider,
        model: this.model.trim(),
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
