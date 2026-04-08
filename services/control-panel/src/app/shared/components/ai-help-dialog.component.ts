import { Component, DestroyRef, inject, input, output, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AiProviderService } from '../../core/services/ai-provider.service';
import type { AiHelpResponse } from '../../core/services/ticket.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from './index.js';

/** @deprecated Use AiHelpResponse from ticket.service instead. */
export type AiHelpDialogResult = AiHelpResponse;

interface ModelOption {
  provider: string;
  model: string;
  name: string;
  label: string;
}

@Component({
  selector: 'app-ai-help-dialog-content',
  standalone: true,
  imports: [FormFieldComponent, TextareaComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Model">
        <app-select
          [value]="selectedModel"
          [options]="modelSelectOptions"
          [placeholder]="''"
          (valueChange)="selectedModel = $event" />
      </app-form-field>

      <app-form-field label="Question">
        <app-textarea
          [value]="question"
          [rows]="4"
          placeholder="e.g. What should I investigate first?"
          (valueChange)="question = $event"
          (keydown.meta.enter)="!loading() && submit()"
          (keydown.control.enter)="!loading() && submit()" />
      </app-form-field>
    </div>

    @if (loading()) {
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
    }

    @if (response()) {
      <div class="ai-response">
        <div class="ai-response-header">
          <span>AI Response</span>
          <span class="ai-provider">{{ response()!.provider }} / {{ response()!.model }}</span>
        </div>
        <div class="ai-response-content">{{ response()!.content }}</div>
      </div>
    }

    @if (errorMsg()) {
      <div class="error-msg">{{ errorMsg() }}</div>
    }

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="closed.emit()">Close</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="loading()" (click)="submit()">
        {{ loading() ? 'Thinking...' : 'Ask AI' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }
    .progress-bar { height: 3px; background: var(--bg-muted); border-radius: 2px; overflow: hidden; margin-bottom: 12px; }
    .progress-bar-fill { height: 100%; background: var(--accent); animation: progress-indeterminate 1.5s ease-in-out infinite; transform-origin: left; }
    @keyframes progress-indeterminate {
      0% { transform: translateX(-100%) scaleX(0.4); }
      50% { transform: translateX(60%) scaleX(0.4); }
      100% { transform: translateX(200%) scaleX(0.4); }
    }
    .ai-response { margin-top: 12px; padding: 12px; background: var(--color-purple-subtle); border-radius: var(--radius-md); max-height: 400px; overflow-y: auto; }
    .ai-response-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-weight: 500; color: var(--color-purple); }
    .ai-provider { font-size: 11px; color: var(--text-tertiary); font-family: monospace; margin-left: auto; }
    .ai-response-content { white-space: pre-wrap; line-height: 1.6; font-size: 13px; }
    .error-msg { margin-top: 12px; padding: 8px 12px; background: var(--color-error-subtle); color: var(--color-error); border-radius: var(--radius-sm); font-size: 13px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class AiHelpDialogComponent implements OnInit {
  private providerService = inject(AiProviderService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  submitFn = input.required<(params: { question?: string; provider?: string; model?: string }) => Promise<AiHelpResponse>>();
  closed = output<void>();

  modelOptions = signal<ModelOption[]>([]);
  selectedModel = '';
  question = '';
  loading = signal(false);
  response = signal<AiHelpResponse | null>(null);
  errorMsg = signal<string | null>(null);

  get modelSelectOptions(): Array<{ value: string; label: string }> {
    return [
      { value: '', label: 'Default (auto-routed)' },
      ...this.modelOptions().map(m => ({ value: `${m.provider}:${m.model}`, label: m.label })),
    ];
  }

  ngOnInit(): void {
    this.providerService.listModels()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(models => {
        const options: ModelOption[] = models
          .filter(m => m.isActive && m.providerActive)
          .map(m => ({
            provider: m.provider,
            model: m.model,
            name: m.name,
            label: `${m.provider} / ${m.name}`,
          }));
        this.modelOptions.set(options);
      });
  }

  submit(): void {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.response.set(null);

    let provider: string | undefined;
    let model: string | undefined;
    if (this.selectedModel) {
      const idx = this.selectedModel.indexOf(':');
      if (idx > 0) {
        provider = this.selectedModel.slice(0, idx);
        model = this.selectedModel.slice(idx + 1);
      }
    }

    Promise.resolve().then(() => this.submitFn()({
      question: this.question || undefined,
      provider,
      model,
    })).then(res => {
      this.loading.set(false);
      this.response.set(res);
    }).catch(err => {
      this.loading.set(false);
      const msg = err?.error?.message ?? err?.message ?? 'AI request failed';
      this.errorMsg.set(msg);
      this.toast.error(msg);
    });
  }
}
