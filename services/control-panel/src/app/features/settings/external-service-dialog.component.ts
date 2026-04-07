import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
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

export interface ExternalServiceDialogData {
  service?: ExternalService;
}

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatCheckboxModule,
  ],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Edit' : 'Add' }} External Service</h2>
    <mat-dialog-content>
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
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name || !endpoint">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .monitor-checkbox { display: block; margin: 8px 0 16px; }
  `],
})
export class ExternalServiceDialogComponent {
  private dialogRef = inject(MatDialogRef<ExternalServiceDialogComponent>);
  private data: ExternalServiceDialogData = inject(MAT_DIALOG_DATA);
  private svc = inject(ExternalServiceService);
  private toast = inject(ToastService);

  isEdit = !!this.data.service;

  name = this.data.service?.name ?? '';
  endpoint = this.data.service?.endpoint ?? '';
  checkType = this.data.service?.checkType ?? 'HTTP';
  timeoutMs = this.data.service?.timeoutMs ?? 5000;
  isMonitored = this.data.service?.isMonitored ?? true;
  notes = this.data.service?.notes ?? '';

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

    const op$ = this.isEdit
      ? this.svc.update(this.data.service!.id, payload)
      : this.svc.create(payload);

    op$.subscribe({
      next: () => {
        this.toast.success(`External service ${this.isEdit ? 'updated' : 'created'}`);
        this.dialogRef.close(true);
      },
      error: (err) =>
        this.toast.error(err.error?.error ?? err.error?.message ?? 'Failed'),
    });
  }
}
