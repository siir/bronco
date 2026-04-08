import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ExternalServiceService,
  ExternalService,
} from '../../core/services/external-service.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-external-service-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    FormFieldComponent,
    TextInputComponent,
    TextareaComponent,
    SelectComponent,
    BroncoButtonComponent,
  ],
  template: `
    <div class="form-grid">
      <app-form-field label="Name" hint="Display name shown on System Status page">
        <app-text-input [value]="name" placeholder="e.g. Ollama (Local LLM)" (valueChange)="name = $event" />
      </app-form-field>

      <app-form-field label="Endpoint" [hint]="endpointHint()">
        <app-text-input [value]="endpoint" [placeholder]="endpointPlaceholder()" (valueChange)="endpoint = $event" />
      </app-form-field>

      <app-form-field label="Check Type" hint="How to verify the service is healthy">
        <app-select [value]="checkType" [options]="checkTypeOptions" (valueChange)="checkType = $event" />
      </app-form-field>

      <app-form-field label="Timeout (ms)">
        <app-text-input [value]="'' + timeoutMs" type="number" (valueChange)="timeoutMs = parseTimeout($event)" />
      </app-form-field>

      <label class="checkbox-row">
        <input type="checkbox" [(ngModel)]="isMonitored">
        <span>Include in System Status monitoring</span>
      </label>

      <app-form-field label="Notes">
        <app-textarea [value]="notes" [rows]="2" (valueChange)="notes = $event" />
      </app-form-field>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!name || !endpoint" (click)="save()">
        {{ isEdit ? 'Update' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-secondary); cursor: pointer; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ExternalServiceDialogComponent implements OnInit {
  private svc = inject(ExternalServiceService);
  private toast = inject(ToastService);

  service = input<ExternalService | undefined>(undefined);
  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;
  name = '';
  endpoint = '';
  checkType: string = 'HTTP';
  timeoutMs = 5000;
  isMonitored = true;
  notes = '';

  checkTypeOptions = [
    { value: 'HTTP', label: 'HTTP — Generic health check' },
    { value: 'OLLAMA', label: 'Ollama — Model info via /api/tags' },
    { value: 'DOCKER', label: 'Docker — Container state check' },
  ];

  ngOnInit(): void {
    const s = this.service();
    if (s) {
      this.isEdit = true;
      this.name = s.name;
      this.endpoint = s.endpoint;
      this.checkType = s.checkType;
      this.timeoutMs = s.timeoutMs;
      this.isMonitored = s.isMonitored;
      this.notes = s.notes ?? '';
    }
  }

  endpointPlaceholder(): string {
    switch (this.checkType) {
      case 'OLLAMA': return 'http://ollama.internal:11434';
      case 'DOCKER': return 'caddy';
      default: return 'http://service:3100/health';
    }
  }

  endpointHint(): string {
    switch (this.checkType) {
      case 'OLLAMA': return 'Ollama base URL (checks /api/tags)';
      case 'DOCKER': return 'Docker container name';
      default: return 'Full URL to probe';
    }
  }

  parseTimeout(val: string): number {
    const n = parseInt(val, 10);
    return Number.isNaN(n) || n <= 0 ? 5000 : n;
  }

  save(): void {
    const payload = {
      name: this.name,
      endpoint: this.endpoint,
      checkType: this.checkType,
      timeoutMs: this.timeoutMs,
      isMonitored: this.isMonitored,
      notes: this.notes || null,
    };

    const s = this.service();
    const op$ = this.isEdit && s
      ? this.svc.update(s.id, payload)
      : this.svc.create(payload);

    op$.subscribe({
      next: () => {
        this.toast.success(`External service ${this.isEdit ? 'updated' : 'created'}`);
        this.saved.emit(true);
      },
      error: (err) =>
        this.toast.error(err.error?.error ?? err.error?.message ?? 'Failed'),
    });
  }
}
