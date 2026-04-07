import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  ExternalServiceService,
  ExternalService,
} from '../../core/services/external-service.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-external-service-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatCheckboxModule,
  ],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="name" placeholder="e.g. Ollama (Local LLM)">
      <mat-hint>Display name shown on System Status page</mat-hint>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Endpoint</mat-label>
      <input matInput [(ngModel)]="endpoint" [placeholder]="endpointPlaceholder()">
      <mat-hint>{{ endpointHint() }}</mat-hint>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Check Type</mat-label>
      <mat-select [(ngModel)]="checkType">
        <mat-option value="HTTP">HTTP — Generic health check</mat-option>
        <mat-option value="OLLAMA">Ollama — Model info via /api/tags</mat-option>
        <mat-option value="DOCKER">Docker — Container state check</mat-option>
      </mat-select>
      <mat-hint>How to verify the service is healthy</mat-hint>
    </mat-form-field>

    <mat-form-field class="full-width">
      <mat-label>Timeout (ms)</mat-label>
      <input matInput type="number" [(ngModel)]="timeoutMs" min="1000" max="30000">
    </mat-form-field>

    <mat-checkbox [(ngModel)]="isMonitored" class="monitor-checkbox">
      Include in System Status monitoring
    </mat-checkbox>

    <mat-form-field class="full-width">
      <mat-label>Notes</mat-label>
      <textarea matInput [(ngModel)]="notes" rows="2"></textarea>
    </mat-form-field>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name || !endpoint">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .monitor-checkbox { display: block; margin: 8px 0 16px; }
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
