import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiProviderService, AiProvider, ProviderType } from '../../core/services/ai-provider.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-ai-provider-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      @if (!isEdit) {
        <app-form-field label="Provider">
          <app-select
            [value]="providerVal"
            [options]="providerOptions"
            [disabled]="loadingProviders"
            placeholder="Select provider..."
            (valueChange)="providerVal = $event; onProviderChange()" />
        </app-form-field>
      } @else {
        <div class="provider-display">
          <span class="label">Provider:</span>
          <span class="provider-chip provider-{{ providerVal.toLowerCase() }}">{{ providerVal }}</span>
        </div>
      }

      @if (providerVal === 'LOCAL') {
        <app-form-field label="Base URL">
          <app-text-input
            [value]="baseUrl"
            placeholder="http://localhost:11434"
            (valueChange)="baseUrl = $event" />
        </app-form-field>
      }

      @if (providerVal && providerVal !== 'LOCAL') {
        <app-form-field label="API Key">
          <app-text-input
            [value]="apiKey"
            type="password"
            [placeholder]="isEdit ? '(unchanged)' : 'sk-...'"
            (valueChange)="apiKey = $event" />
        </app-form-field>
      }
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
    .provider-display { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .provider-display .label { font-size: 13px; color: #666; }
    .provider-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #f5f5f5; color: #333; }
    .provider-local { background: #e8f5e9; color: #2e7d32; }
    .provider-claude { background: #fce4ec; color: #c62828; }
    .provider-openai { background: #e3f2fd; color: #1565c0; }
    .provider-grok { background: #fff3e0; color: #e65100; }
    .provider-google { background: #e8f5e9; color: #1b5e20; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class AiProviderDialogComponent implements OnInit {
  private providerService = inject(AiProviderService);
  private toast = inject(ToastService);

  config = input<AiProvider>();

  saved = output<AiProvider>();
  cancelled = output<void>();

  isEdit = false;
  providerVal = '';
  baseUrl = '';
  apiKey = '';

  loadingProviders = true;
  selectableProviders: ProviderType[] = [];

  get providerOptions(): Array<{ value: string; label: string }> {
    return this.selectableProviders.map(p => ({ value: p.value, label: p.label + (p.routable ? '' : ' (not yet supported)') }));
  }

  ngOnInit(): void {
    const cfg = this.config();
    this.isEdit = !!cfg;
    this.providerVal = cfg?.provider ?? '';
    this.baseUrl = cfg?.baseUrl ?? '';

    this.providerService.getTypes().subscribe({
      next: (types) => {
        this.selectableProviders = types;
        this.loadingProviders = false;
      },
      error: () => {
        this.loadingProviders = false;
        this.toast.error('Failed to load provider types');
      },
    });
  }

  onProviderChange(): void {
    if (this.providerVal === 'LOCAL' && !this.baseUrl) {
      this.baseUrl = 'http://localhost:11434';
    }
  }

  canSave(): boolean {
    if (!this.providerVal) return false;
    if (this.providerVal === 'LOCAL' && !this.baseUrl.trim()) return false;
    if (this.providerVal !== 'LOCAL' && !this.isEdit && !this.apiKey.trim()) return false;
    return true;
  }

  save(): void {
    if (this.isEdit) {
      const data: Record<string, unknown> = {};
      if (this.providerVal === 'LOCAL') data['baseUrl'] = this.baseUrl.trim();
      if (this.apiKey) data['apiKey'] = this.apiKey;
      this.providerService.updateProvider(this.config()!.id, data).subscribe({
        next: (result) => {
          this.toast.success('Provider updated');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to update provider'),
      });
    } else {
      this.providerService.createProvider({
        provider: this.providerVal,
        baseUrl: this.providerVal === 'LOCAL' ? this.baseUrl.trim() : undefined,
        apiKey: this.providerVal !== 'LOCAL' ? this.apiKey : undefined,
      }).subscribe({
        next: (result) => {
          this.toast.success('Provider created');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to create provider'),
      });
    }
  }
}
