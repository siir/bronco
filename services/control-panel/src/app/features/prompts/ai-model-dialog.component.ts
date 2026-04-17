import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiProviderService, AiProvider, AiProviderModel, AppScopeItem } from '../../core/services/ai-provider.service.js';
import { AiUsageService, CatalogModel } from '../../core/services/ai-usage.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

const CAPABILITY_LEVELS = [
  { value: 'SIMPLE', label: 'Simple — classification, tagging' },
  { value: 'BASIC', label: 'Basic — extraction, intent, log summarization' },
  { value: 'STANDARD', label: 'Standard — drafting, analysis, summarization' },
  { value: 'ADVANCED', label: 'Advanced — planning, SQL, code review' },
  { value: 'DEEP_ADVANCED', label: 'Deep Advanced — architecture, deep analysis, large codebase' },
];

@Component({
  selector: 'app-ai-model-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Provider">
        <app-select
          [value]="providerId"
          [options]="providerOptions"
          (valueChange)="providerId = $event; onProviderChange()" />
      </app-form-field>

      <app-form-field label="Name">
        <app-text-input
          [value]="name"
          placeholder="e.g. Claude Sonnet Production, Ollama Fast"
          (valueChange)="name = $event" />
      </app-form-field>

      @if (modelsForProvider.length > 0) {
        <app-form-field label="Model">
          <app-select
            [value]="modelId"
            [options]="modelOptions"
            (valueChange)="modelId = $event" />
        </app-form-field>
      } @else {
        <app-form-field label="Model">
          <app-text-input
            [value]="modelId"
            placeholder="e.g. llama3.1:8b or claude-sonnet-4-6"
            (valueChange)="modelId = $event" />
        </app-form-field>
      }

      <app-form-field label="Capability Level">
        <app-select
          [value]="capabilityLevel"
          [options]="capabilityLevels"
          (valueChange)="capabilityLevel = $event" />
      </app-form-field>

      <div class="enabled-apps-section">
        <div class="section-label">Enabled For</div>
        <div class="section-hint">Leave unchecked to allow all apps. Check specific apps to restrict availability.</div>
        <div class="checkbox-group">
          @for (scope of appScopes; track scope.value) {
            <label class="checkbox-item">
              <input type="checkbox" class="form-checkbox"
                [checked]="enabledApps.has(scope.value)"
                (change)="toggleAppScope(scope.value, $any($event.target).checked)">
              {{ scope.label }}
            </label>
          }
        </div>
      </div>
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
    .enabled-apps-section { display: flex; flex-direction: column; gap: 4px; }
    .section-label { font-size: 13px; font-weight: 600; color: var(--text-tertiary); }
    .section-hint { font-size: 12px; color: var(--text-tertiary); }
    .checkbox-group { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
    .checkbox-item { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
    .form-checkbox { width: 15px; height: 15px; cursor: pointer; accent-color: var(--accent); }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class AiModelDialogComponent implements OnInit {
  private providerService = inject(AiProviderService);
  private aiUsageService = inject(AiUsageService);
  private toast = inject(ToastService);

  model = input<AiProviderModel>();
  providers = input.required<AiProvider[]>();

  saved = output<AiProviderModel>();
  cancelled = output<void>();

  capabilityLevels = CAPABILITY_LEVELS;

  isEdit = false;
  availableProviders: AiProvider[] = [];
  providerId = '';
  name = '';
  modelId = '';
  capabilityLevel = 'STANDARD';
  enabledApps = new Set<string>();
  appScopes: AppScopeItem[] = [];

  private catalogMap = new Map<string, CatalogModel[]>();
  modelsForProvider: CatalogModel[] = [];

  get providerOptions(): Array<{ value: string; label: string }> {
    return [
      { value: '', label: 'Select provider...' },
      ...this.availableProviders.map(p => ({ value: p.id, label: p.provider + (p.isActive ? '' : ' (disabled)') })),
    ];
  }

  get modelOptions(): Array<{ value: string; label: string }> {
    return this.modelsForProvider.map(m => ({ value: m.model, label: m.displayName || m.model }));
  }

  private getSelectedProviderType(): string {
    const p = this.availableProviders.find((pr) => pr.id === this.providerId);
    return p?.provider ?? '';
  }

  ngOnInit(): void {
    const m = this.model();
    this.isEdit = !!m;
    this.availableProviders = this.providers();
    this.providerId = m?.providerId ?? (this.availableProviders.length === 1 ? this.availableProviders[0].id : '');
    this.name = m?.name ?? '';
    this.modelId = m?.model ?? '';
    this.capabilityLevel = m?.capabilityLevel ?? 'STANDARD';
    this.enabledApps = new Set<string>(m?.enabledApps ?? []);

    this.aiUsageService.getCatalog().subscribe(catalog => {
      for (const p of catalog.providers) {
        this.catalogMap.set(p.provider, p.models);
      }
      this.updateModelsForProvider();
    });

    this.providerService.getAppScopes().subscribe({
      next: (scopes) => this.appScopes = scopes,
      error: () => this.toast.error('Failed to load app scopes'),
    });
  }

  onProviderChange(): void {
    this.updateModelsForProvider();
    if (!this.isEdit) {
      this.modelId = '';
    }
  }

  toggleAppScope(scope: string, checked: boolean): void {
    if (checked) {
      this.enabledApps.add(scope);
    } else {
      this.enabledApps.delete(scope);
    }
  }

  private updateModelsForProvider(): void {
    const providerType = this.getSelectedProviderType();
    this.modelsForProvider = this.catalogMap.get(providerType) ?? [];
    if (this.modelId && !this.modelsForProvider.some(m => m.model === this.modelId)) {
      this.modelsForProvider = [{ model: this.modelId, displayName: this.modelId, contextLength: null, maxCompletionTokens: null, modality: null }, ...this.modelsForProvider];
    }
  }

  canSave(): boolean {
    if (!this.providerId || !this.name.trim() || !this.modelId.trim()) return false;
    return true;
  }

  save(): void {
    const enabledAppsArray = [...this.enabledApps];
    if (this.isEdit) {
      this.providerService.updateModel(this.model()!.id, {
        providerId: this.providerId,
        name: this.name.trim(),
        model: this.modelId.trim(),
        capabilityLevel: this.capabilityLevel,
        enabledApps: enabledAppsArray,
      }).subscribe({
        next: (result) => {
          this.toast.success('Model updated');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to update model'),
      });
    } else {
      this.providerService.createModel({
        providerId: this.providerId,
        name: this.name.trim(),
        model: this.modelId.trim(),
        capabilityLevel: this.capabilityLevel,
        enabledApps: enabledAppsArray,
      }).subscribe({
        next: (result) => {
          this.toast.success('Model created');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to create model'),
      });
    }
  }
}
