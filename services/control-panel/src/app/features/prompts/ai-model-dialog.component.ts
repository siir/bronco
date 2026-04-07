import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { AiProviderService, AiProvider, AiProviderModel, AppScopeItem } from '../../core/services/ai-provider.service';
import { AiUsageService, CatalogModel } from '../../core/services/ai-usage.service';
import { ToastService } from '../../core/services/toast.service';

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
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatCheckboxModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Provider</mat-label>
      <mat-select [(ngModel)]="providerId" required (ngModelChange)="onProviderChange()">
        @for (p of availableProviders; track p.id) {
          <mat-option [value]="p.id">
            {{ p.provider }}{{ p.isActive ? '' : ' (disabled)' }}
          </mat-option>
        }
      </mat-select>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="name" required placeholder="e.g. Claude Sonnet Production, Ollama Fast">
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Model</mat-label>
      @if (modelsForProvider.length > 0) {
        <mat-select [(ngModel)]="modelId" required>
          @for (m of modelsForProvider; track m.model) {
            <mat-option [value]="m.model">{{ m.displayName || m.model }}</mat-option>
          }
        </mat-select>
      } @else {
        <input matInput [(ngModel)]="modelId" required placeholder="e.g. llama3.1:8b or claude-sonnet-4-6">
      }
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Capability Level</mat-label>
      <mat-select [(ngModel)]="capabilityLevel" required>
        @for (lvl of capabilityLevels; track lvl.value) {
          <mat-option [value]="lvl.value">{{ lvl.label }}</mat-option>
        }
      </mat-select>
    </mat-form-field>

    <div class="enabled-apps-section">
      <div class="section-label">Enabled For</div>
      <div class="section-hint">Leave unchecked to allow all apps. Check specific apps to restrict availability.</div>
      <div class="checkbox-group">
        @for (scope of appScopes; track scope.value) {
          <mat-checkbox
            [checked]="enabledApps.has(scope.value)"
            (change)="toggleAppScope(scope.value, $event.checked)">
            {{ scope.label }}
          </mat-checkbox>
        }
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .enabled-apps-section { margin-bottom: 16px; }
    .section-label { font-size: 13px; font-weight: 600; color: #666; margin-bottom: 4px; }
    .section-hint { font-size: 12px; color: #999; margin-bottom: 8px; }
    .checkbox-group { display: flex; flex-wrap: wrap; gap: 12px; }
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
