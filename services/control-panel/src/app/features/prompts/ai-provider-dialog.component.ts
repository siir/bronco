import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { AiProviderService, AiProvider, ProviderType } from '../../core/services/ai-provider.service';
import { ToastService } from '../../core/services/toast.service';

interface DialogData {
  config?: AiProvider;
}

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Edit' : 'Add' }} Provider</h2>
    <mat-dialog-content>
      @if (!isEdit) {
        <mat-form-field class="full-width">
          <mat-label>Provider</mat-label>
          <mat-select [(ngModel)]="provider" required (ngModelChange)="onProviderChange()">
            @if (loadingProviders) {
              <mat-option disabled>Loading providers...</mat-option>
            }
            @for (p of selectableProviders; track p.value) {
              <mat-option [value]="p.value" [disabled]="!p.routable">{{ p.label }}{{ p.routable ? '' : ' (not yet supported)' }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      } @else {
        <div class="provider-display">
          <span class="label">Provider:</span>
          <span class="provider-chip provider-{{ provider.toLowerCase() }}">{{ provider }}</span>
        </div>
      }

      @if (provider === 'LOCAL') {
        <mat-form-field class="full-width">
          <mat-label>Base URL</mat-label>
          <input matInput [(ngModel)]="baseUrl" required placeholder="http://localhost:11434">
        </mat-form-field>
      }

      @if (provider && provider !== 'LOCAL') {
        <mat-form-field class="full-width">
          <mat-label>API Key</mat-label>
          <input matInput [(ngModel)]="apiKey" type="password"
            [required]="!isEdit" [placeholder]="isEdit ? '(unchanged)' : 'sk-...'">
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .provider-display { margin-bottom: 16px; }
    .provider-display .label { font-size: 13px; color: #666; margin-right: 8px; }
    .provider-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #f5f5f5; color: #333; }
    .provider-local { background: #e8f5e9; color: #2e7d32; }
    .provider-claude { background: #fce4ec; color: #c62828; }
    .provider-openai { background: #e3f2fd; color: #1565c0; }
    .provider-grok { background: #fff3e0; color: #e65100; }
    .provider-google { background: #e8f5e9; color: #1b5e20; }
  `],
})
export class AiProviderDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<AiProviderDialogComponent>);
  data: DialogData = inject(MAT_DIALOG_DATA);
  private providerService = inject(AiProviderService);
  private toast = inject(ToastService);

  isEdit = !!this.data.config;
  provider = this.data.config?.provider ?? '';
  baseUrl = this.data.config?.baseUrl ?? '';
  apiKey = '';

  loadingProviders = true;
  selectableProviders: ProviderType[] = [];

  ngOnInit(): void {
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
    if (this.provider === 'LOCAL' && !this.baseUrl) {
      this.baseUrl = 'http://localhost:11434';
    }
  }

  canSave(): boolean {
    if (!this.provider) return false;
    if (this.provider === 'LOCAL' && !this.baseUrl.trim()) return false;
    if (this.provider !== 'LOCAL' && !this.isEdit && !this.apiKey.trim()) return false;
    return true;
  }

  save(): void {
    if (this.isEdit) {
      const data: Record<string, unknown> = {};
      if (this.provider === 'LOCAL') data['baseUrl'] = this.baseUrl.trim();
      if (this.apiKey) data['apiKey'] = this.apiKey;
      this.providerService.updateProvider(this.data.config!.id, data).subscribe({
        next: (result) => {
          this.toast.success('Provider updated');
          this.dialogRef.close(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to update provider'),
      });
    } else {
      this.providerService.createProvider({
        provider: this.provider,
        baseUrl: this.provider === 'LOCAL' ? this.baseUrl.trim() : undefined,
        apiKey: this.provider !== 'LOCAL' ? this.apiKey : undefined,
      }).subscribe({
        next: (result) => {
          this.toast.success('Provider created');
          this.dialogRef.close(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to create provider'),
      });
    }
  }
}
