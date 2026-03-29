import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AiProviderService, AiProvider, AiProviderModel } from '../../core/services/ai-provider.service';
import { AiProviderDialogComponent } from '../prompts/ai-provider-dialog.component';
import { AiModelDialogComponent } from '../prompts/ai-model-dialog.component';

@Component({
  standalone: true,
  imports: [FormsModule, MatCardModule, MatTableModule, MatButtonModule, MatIconModule, MatSlideToggleModule, MatTooltipModule, MatDialogModule],
  template: `
    <div class="page-header">
      <h1>AI Providers & Models</h1>
    </div>

    <!-- Providers Section -->
    <div class="section-header">
      <h2>Providers</h2>
      <button mat-raised-button color="primary" (click)="addProvider()">
        <mat-icon>add</mat-icon> Add Provider
      </button>
    </div>

    <mat-card class="section-card">
      <table mat-table [dataSource]="providers()" class="full-width">
        <ng-container matColumnDef="provider">
          <th mat-header-cell *matHeaderCellDef>Provider</th>
          <td mat-cell *matCellDef="let p">
            <span class="provider-chip provider-{{ p.provider.toLowerCase() }}">{{ p.provider }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="baseUrl">
          <th mat-header-cell *matHeaderCellDef>Base URL</th>
          <td mat-cell *matCellDef="let p">
            @if (p.baseUrl) {
              <code class="url-text">{{ p.baseUrl }}</code>
            } @else {
              <span class="muted">—</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="apiKey">
          <th mat-header-cell *matHeaderCellDef>API Key</th>
          <td mat-cell *matCellDef="let p">
            @if (p.hasApiKey) {
              <mat-icon class="key-icon">lock</mat-icon>
            } @else {
              <span class="muted">—</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="models">
          <th mat-header-cell *matHeaderCellDef>Models</th>
          <td mat-cell *matCellDef="let p">
            <span class="code-chip">{{ p.activeModelCount }}/{{ p.modelCount }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="active">
          <th mat-header-cell *matHeaderCellDef>Active</th>
          <td mat-cell *matCellDef="let p">
            <mat-slide-toggle
              [checked]="p.isActive"
              (change)="toggleProviderActive(p)"
              color="primary">
            </mat-slide-toggle>
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let p">
            <button mat-icon-button matTooltip="Test Connection" (click)="testProvider(p)">
              <mat-icon>wifi_tethering</mat-icon>
            </button>
            <button mat-icon-button (click)="editProvider(p)">
              <mat-icon>edit</mat-icon>
            </button>
            <button mat-icon-button color="warn" matTooltip="Delete provider and all its models" (click)="deleteProvider(p)">
              <mat-icon>delete</mat-icon>
            </button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="providerColumns"></tr>
        <tr mat-row *matRowDef="let row; columns: providerColumns;"></tr>
      </table>
    </mat-card>

    @if (providers().length === 0) {
      <p class="empty">No providers configured. Add a provider to get started.</p>
    }

    <!-- Models Section -->
    <div class="section-header models-section">
      <h2>Models</h2>
      <button mat-raised-button color="primary" (click)="addModel()" [disabled]="providers().length === 0">
        <mat-icon>add</mat-icon> Add Model
      </button>
    </div>

    @if (disabledProviderTypes().length > 0) {
      <div class="provider-warning-banner">
        <mat-icon>warning</mat-icon>
        <span>
          @for (p of disabledProviderTypes(); track p; let last = $last) {
            <strong>{{ p }}</strong>{{ last ? '' : ', ' }}
          }
          {{ disabledProviderTypes().length > 1 ? 'providers are' : 'provider is' }} unavailable (disabled or with no active models).
          Models under these providers will not be routed to.
        </span>
      </div>
    }

    <mat-card class="section-card">
      <table mat-table [dataSource]="models()" class="full-width">
        <ng-container matColumnDef="name">
          <th mat-header-cell *matHeaderCellDef>Name</th>
          <td mat-cell *matCellDef="let m">{{ m.name }}</td>
        </ng-container>

        <ng-container matColumnDef="provider">
          <th mat-header-cell *matHeaderCellDef>Provider</th>
          <td mat-cell *matCellDef="let m">
            <span class="provider-chip provider-{{ m.provider.toLowerCase() }}">{{ m.provider }}</span>
            @if (!m.providerActive) {
              <mat-icon class="inline-warn-icon" matTooltip="Provider is disabled">warning</mat-icon>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="model">
          <th mat-header-cell *matHeaderCellDef>Model</th>
          <td mat-cell *matCellDef="let m">
            <code class="model-name">{{ m.model }}</code>
          </td>
        </ng-container>

        <ng-container matColumnDef="capability">
          <th mat-header-cell *matHeaderCellDef>Capability</th>
          <td mat-cell *matCellDef="let m">
            <span class="code-chip">{{ m.capabilityLevel }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="enabledApps">
          <th mat-header-cell *matHeaderCellDef>Enabled For</th>
          <td mat-cell *matCellDef="let m">
            @if (m.enabledApps.length === 0) {
              <span class="scope-chip scope-all">All Apps</span>
            } @else {
              @for (app of m.enabledApps; track app) {
                <span class="scope-chip">{{ appScopeLabel(app) }}</span>
              }
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="active">
          <th mat-header-cell *matHeaderCellDef>Active</th>
          <td mat-cell *matCellDef="let m">
            <mat-slide-toggle
              [checked]="m.isActive"
              (change)="toggleModelActive(m)"
              color="primary">
            </mat-slide-toggle>
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let m">
            <button mat-icon-button (click)="editModel(m)">
              <mat-icon>edit</mat-icon>
            </button>
            <button mat-icon-button color="warn" (click)="deleteModel(m)">
              <mat-icon>delete</mat-icon>
            </button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="modelColumns"></tr>
        <tr mat-row *matRowDef="let row; columns: modelColumns;"></tr>
      </table>
    </mat-card>

    @if (models().length === 0) {
      <p class="empty">No models configured. Add a model to enable AI features.</p>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .section-header h2 { margin: 0; font-size: 18px; }
    .section-card { margin-bottom: 24px; }
    .models-section { margin-top: 32px; }
    .full-width { width: 100%; }
    .provider-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #f5f5f5; color: #333; }
    .provider-local { background: #e8f5e9; color: #2e7d32; }
    .provider-claude { background: #fce4ec; color: #c62828; }
    .provider-openai { background: #e3f2fd; color: #1565c0; }
    .provider-grok { background: #fff3e0; color: #e65100; }
    .provider-google { background: #e8f5e9; color: #1b5e20; }
    .model-name { font-size: 13px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    .url-text { font-size: 12px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; word-break: break-all; }
    .code-chip { font-size: 12px; padding: 2px 8px; background: #e8eaf6; border-radius: 4px; color: #3f51b5; font-family: monospace; }
    .key-icon { font-size: 18px; color: #888; }
    .muted { color: #999; }
    .empty { color: #999; padding: 16px; text-align: center; }
    .provider-warning-banner { display: flex; align-items: center; gap: 8px; padding: 12px 16px; margin-bottom: 16px; background: #fff3e0; border: 1px solid #ffe0b2; border-radius: 8px; color: #e65100; font-size: 13px; }
    .provider-warning-banner mat-icon { color: #e65100; flex-shrink: 0; }
    .scope-chip { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px; background: #e8eaf6; color: #3f51b5; margin-right: 4px; display: inline-block; margin-bottom: 2px; }
    .scope-all { background: #e8f5e9; color: #2e7d32; }
    .inline-warn-icon { font-size: 16px; width: 16px; height: 16px; color: #e65100; vertical-align: middle; margin-left: 4px; }
  `],
})
export class AiProvidersComponent implements OnInit {
  private aiProviderService = inject(AiProviderService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  providers = signal<AiProvider[]>([]);
  models = signal<AiProviderModel[]>([]);
  providerColumns = ['provider', 'baseUrl', 'apiKey', 'models', 'active', 'actions'];
  modelColumns = ['name', 'provider', 'model', 'capability', 'enabledApps', 'active', 'actions'];

  private appScopeLabels = signal<Record<string, string>>({});

  appScopeLabel(scope: string): string {
    return this.appScopeLabels()[scope] ?? scope;
  }

  disabledProviderTypes = computed(() => {
    return this.providers().filter((p) => !p.isActive || p.activeModelCount === 0).map((p) => p.provider);
  });

  ngOnInit(): void {
    this.loadAll();
    this.aiProviderService.getAppScopes().subscribe((scopes) => {
      const map: Record<string, string> = {};
      for (const s of scopes) map[s.value] = s.label;
      this.appScopeLabels.set(map);
    });
  }

  loadAll(): void {
    this.aiProviderService.listProviders().subscribe(providers => this.providers.set(providers));
    this.aiProviderService.listModels().subscribe(models => this.models.set(models));
  }

  // --- Provider actions ---

  addProvider(): void {
    const ref = this.dialog.open(AiProviderDialogComponent, { width: '500px', data: {} });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  editProvider(config: AiProvider): void {
    const ref = this.dialog.open(AiProviderDialogComponent, { width: '500px', data: { config } });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  toggleProviderActive(config: AiProvider): void {
    this.aiProviderService.updateProvider(config.id, { isActive: !config.isActive }).subscribe({
      next: () => {
        this.snackBar.open(`Provider ${config.isActive ? 'deactivated' : 'activated'}`, 'OK', { duration: 3000 });
        this.loadAll();
      },
      error: () => this.snackBar.open('Failed to update provider', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  testProvider(config: AiProvider): void {
    this.snackBar.open('Testing connection...', '', { duration: 10000 });
    this.aiProviderService.testConnection(config.id).subscribe({
      next: (result) => {
        if (result.success) {
          this.snackBar.open(result.note ?? 'Connection successful', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
        } else {
          this.snackBar.open(result.error ?? 'Connection failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
        }
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Test failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  deleteProvider(config: AiProvider): void {
    const modelWarning = config.modelCount > 0 ? ` This will also delete ${config.modelCount} model(s).` : '';
    if (!confirm(`Delete provider "${config.provider}"?${modelWarning}`)) return;
    this.aiProviderService.deleteProvider(config.id).subscribe({
      next: () => { this.snackBar.open('Provider deleted', 'OK', { duration: 3000 }); this.loadAll(); },
      error: () => this.snackBar.open('Failed to delete provider', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  // --- Model actions ---

  addModel(): void {
    const ref = this.dialog.open(AiModelDialogComponent, { width: '500px', data: { providers: this.providers() } });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  editModel(model: AiProviderModel): void {
    const ref = this.dialog.open(AiModelDialogComponent, { width: '500px', data: { model, providers: this.providers() } });
    ref.afterClosed().subscribe(result => { if (result) this.loadAll(); });
  }

  toggleModelActive(model: AiProviderModel): void {
    this.aiProviderService.updateModel(model.id, { isActive: !model.isActive }).subscribe({
      next: () => {
        this.snackBar.open(`Model ${model.isActive ? 'deactivated' : 'activated'}`, 'OK', { duration: 3000 });
        this.loadAll();
      },
      error: () => this.snackBar.open('Failed to update model', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  deleteModel(model: AiProviderModel): void {
    if (!confirm(`Delete model "${model.name}"?`)) return;
    this.aiProviderService.deleteModel(model.id).subscribe({
      next: () => { this.snackBar.open('Model deleted', 'OK', { duration: 3000 }); this.loadAll(); },
      error: () => this.snackBar.open('Failed to delete model', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
}
