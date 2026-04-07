import { Component, DestroyRef, inject, OnInit, signal, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { PromptService, PromptDetail, PromptOverride, PreviewResult } from '../../core/services/prompt.service';
import { ClientService, Client } from '../../core/services/client.service';
import { OverrideDialogComponent } from './override-dialog.component';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [RouterLink, FormsModule, MatCardModule, MatButtonModule, MatIconModule, MatChipsModule, MatFormFieldModule, MatSelectModule, MatSlideToggleModule, MatDialogModule],
  template: `
    @if (detail(); as d) {
      <div class="page-header">
        <div>
          <a routerLink="/prompts" class="back-link">AI Prompts</a> /
          <h1 class="inline">{{ d.base.name }}</h1>
        </div>
      </div>

      <div class="prompt-meta">
        <mat-chip>{{ d.base.taskType }}</mat-chip>
        <span class="role-chip role-{{ d.base.role.toLowerCase() }}">{{ d.base.role }}</span>
        @if (d.base.temperature !== null) {
          <span class="meta-label">temp: {{ d.base.temperature }}</span>
        }
        @if (d.base.maxTokens !== null) {
          <span class="meta-label">maxTokens: {{ d.base.maxTokens }}</span>
        }
      </div>

      <p class="description">{{ d.base.description }}</p>

      <!-- Base Prompt Content -->
      <mat-card class="section-card">
        <mat-card-header>
          <mat-card-title>Base Prompt</mat-card-title>
          <mat-card-subtitle>Hardcoded in source — read-only</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          <pre class="prompt-content">{{ d.base.content }}</pre>
        </mat-card-content>
      </mat-card>

      <!-- Overrides -->
      <div class="section-header">
        <h3>Overrides</h3>
        <button mat-raised-button color="primary" (click)="addOverride()">
          <mat-icon>add</mat-icon> Add Override
        </button>
      </div>

      @if (d.overrides.length > 0) {
        @for (o of d.overrides; track o.id) {
          <mat-card class="override-card">
            <mat-card-content>
              <div class="override-header">
                <span class="scope-badge scope-{{ o.scope.toLowerCase() }}">{{ o.scope }}</span>
                <span class="position-badge">{{ o.position }}</span>
                @if (o.client) {
                  <span class="code-chip">{{ o.client.shortCode }}</span>
                }
                <div class="override-actions">
                  <mat-slide-toggle
                    [checked]="o.isActive"
                    (change)="toggleOverride(o)"
                    color="primary">
                  </mat-slide-toggle>
                  <button mat-icon-button (click)="editOverride(o)">
                    <mat-icon>edit</mat-icon>
                  </button>
                  <button mat-icon-button color="warn" (click)="deleteOverride(o)">
                    <mat-icon>delete</mat-icon>
                  </button>
                </div>
              </div>
              <pre class="override-content">{{ o.content }}</pre>
            </mat-card-content>
          </mat-card>
        }
      } @else {
        <p class="empty">No overrides for this prompt.</p>
      }

      <!-- Composed Preview -->
      <mat-card class="section-card preview-card">
        <mat-card-header>
          <mat-card-title>Composed Preview</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <div class="preview-controls">
            <mat-form-field>
              <mat-label>Client</mat-label>
              <mat-select [(ngModel)]="selectedClientId" (ngModelChange)="loadPreview()">
                <mat-option value="">No client (APP_WIDE only)</mat-option>
                @for (c of clients(); track c.id) {
                  <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <button mat-raised-button (click)="loadPreview()">
              <mat-icon>refresh</mat-icon> Refresh
            </button>
          </div>

          @if (preview(); as pv) {
            <pre class="prompt-content">{{ pv.rendered }}</pre>

            @if (pv.placeholders.length > 0) {
              <h4>Placeholders</h4>
              <table class="placeholder-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Label</th>
                    <th>Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  @for (ph of pv.placeholders; track ph.token) {
                    <tr>
                      <td><code>{{ wrapToken(ph.token) }}</code></td>
                      <td>{{ ph.label ?? '-' }}</td>
                      <td>{{ ph.resolved ?? '(unresolved)' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          } @else {
            <p class="muted">Click Refresh to preview the composed prompt.</p>
          }
        </mat-card-content>
      </mat-card>
    } @else {
      <p>Loading...</p>
    }
  `,
  styles: [`
    .page-header { margin-bottom: 16px; }
    .back-link { text-decoration: none; color: #666; }
    .inline { display: inline; margin: 0 8px 0 4px; }
    .prompt-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .role-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .role-system { background: #e3f2fd; color: #1565c0; }
    .role-user { background: #e8f5e9; color: #2e7d32; }
    .meta-label { font-size: 13px; color: #666; font-family: monospace; }
    .description { color: #666; margin-bottom: 24px; }
    .section-card { margin-bottom: 24px; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin: 24px 0 12px; }
    .section-header h3 { margin: 0; }
    .prompt-content { white-space: pre-wrap; word-break: break-word; background: #fafafa; padding: 16px; border-radius: 4px; border: 1px solid #e0e0e0; font-size: 13px; line-height: 1.6; max-height: 400px; overflow: auto; margin: 0; }
    .override-card { margin-bottom: 12px; }
    .override-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .override-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
    .scope-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .scope-app_wide { background: #e8eaf6; color: #3f51b5; }
    .scope-client { background: #fff3e0; color: #e65100; }
    .position-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #f5f5f5; color: #666; }
    .code-chip { font-size: 12px; padding: 2px 8px; background: #e8eaf6; border-radius: 4px; color: #3f51b5; font-family: monospace; }
    .override-content { white-space: pre-wrap; word-break: break-word; background: #fffde7; padding: 12px; border-radius: 4px; border: 1px solid #fff9c4; font-size: 13px; line-height: 1.5; margin: 0; }
    .preview-card { background: #f3e5f5; }
    .preview-controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
    .placeholder-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    .placeholder-table th, .placeholder-table td { text-align: left; padding: 6px 12px; border-bottom: 1px solid #e0e0e0; }
    .placeholder-table th { font-weight: 600; background: #f5f5f5; }
    .muted { color: #999; }
    .empty { color: #999; padding: 16px; text-align: center; }
  `],
})
export class PromptDetailComponent implements OnInit {
  key = input.required<string>();

  private promptService = inject(PromptService);
  private clientService = inject(ClientService);
  private destroyRef = inject(DestroyRef);
  private dialog = inject(MatDialog);
  private toast = inject(ToastService);

  detail = signal<PromptDetail | null>(null);
  preview = signal<PreviewResult | null>(null);
  clients = signal<Client[]>([]);
  selectedClientId = '';

  ngOnInit(): void {
    this.load();
    this.clientService.getClients().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(c => this.clients.set(c));
  }

  wrapToken(token: string): string {
    return `{{${token}}}`;
  }

  load(): void {
    this.promptService.getPrompt(this.key(), this.selectedClientId || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(d => {
        this.detail.set(d);
        this.preview.set(null);
      });
  }

  loadPreview(): void {
    this.promptService.previewPrompt({
      promptKey: this.key(),
      clientId: this.selectedClientId || undefined,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(pv => this.preview.set(pv));
  }

  addOverride(): void {
    const ref = this.dialog.open(OverrideDialogComponent, {
      width: '600px',
      data: { promptKey: this.key() },
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.load();
    });
  }

  editOverride(override: PromptOverride): void {
    const ref = this.dialog.open(OverrideDialogComponent, {
      width: '600px',
      data: { promptKey: this.key(), override },
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.load();
    });
  }

  toggleOverride(override: PromptOverride): void {
    this.promptService.updateOverride(override.id, { isActive: !override.isActive }).subscribe({
      next: () => {
        this.toast.success(`Override ${override.isActive ? 'deactivated' : 'activated'}`);
        this.load();
      },
      error: () => this.toast.error('Failed to update override'),
    });
  }

  deleteOverride(override: PromptOverride): void {
    if (!confirm('Delete this override?')) return;
    this.promptService.deleteOverride(override.id).subscribe({
      next: () => {
        this.toast.success('Override deleted');
        this.load();
      },
      error: () => this.toast.error('Failed to delete override'),
    });
  }
}
