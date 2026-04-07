import { Component, DestroyRef, inject, input, output, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { AiProviderService } from '../../core/services/ai-provider.service';
import type { AiHelpResponse } from '../../core/services/ticket.service';
import { ToastService } from '../../core/services/toast.service';

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
  imports: [CommonModule, FormsModule, MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Model</mat-label>
      <mat-select [(ngModel)]="selectedModel">
        <mat-option value="">Default (auto-routed)</mat-option>
        @for (m of modelOptions(); track m.provider + ':' + m.model) {
          <mat-option [value]="m.provider + ':' + m.model">{{ m.label }}</mat-option>
        }
      </mat-select>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Question</mat-label>
      <textarea matInput [(ngModel)]="question" rows="4"
        placeholder="e.g. What should I investigate first?"
        (keydown.meta.enter)="!loading() && submit()"
        (keydown.control.enter)="!loading() && submit()"></textarea>
    </mat-form-field>

    @if (loading()) {
      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
    }

    @if (response()) {
      <div class="ai-response">
        <div class="ai-response-header">
          <mat-icon>auto_awesome</mat-icon>
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
      <button mat-button (click)="closed.emit()">Close</button>
      <button mat-raised-button color="accent" (click)="submit()" [disabled]="loading()">
        <mat-icon>{{ loading() ? 'hourglass_empty' : 'auto_awesome' }}</mat-icon>
        {{ loading() ? 'Thinking...' : 'Ask AI' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .ai-response { margin-top: 12px; padding: 12px; background: #f3e5f5; border-radius: 8px; max-height: 400px; overflow-y: auto; }
    .ai-response-header { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; font-weight: 500; color: #6a1b9a; }
    .ai-response-header mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .ai-provider { font-size: 11px; color: #666; font-family: monospace; margin-left: auto; }
    .ai-response-content { white-space: pre-wrap; line-height: 1.6; font-size: 13px; }
    .error-msg { margin-top: 12px; padding: 8px 12px; background: #ffebee; color: #c62828; border-radius: 4px; font-size: 13px; }
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
