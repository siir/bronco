import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { PromptService, PromptSummary, PromptKeyword } from '../../core/services/prompt.service';
import { AiConfigService, TaskTypeDefault, AiModelConfig } from '../../core/services/ai-config.service';
import { forkJoin } from 'rxjs';
import { KeywordDialogComponent } from './keyword-dialog.component';
import { AiConfigDialogComponent } from './ai-config-dialog.component';

interface MergedModelRow {
  taskType: string;
  provider: string;
  model: string;
  source: 'DEFAULT' | 'APP_WIDE' | 'CLIENT';
  configId: string | null;
  isActive: boolean;
  clientLabel: string | null;
  isOverridden: boolean;
  defaultProvider: string;
  defaultModel: string;
}

@Component({
  standalone: true,
  imports: [RouterLink, FormsModule, MatCardModule, MatTableModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTabsModule, MatSlideToggleModule, MatTooltipModule, MatDialogModule],
  template: `
    <div class="page-header">
      <h1>AI Prompts</h1>
    </div>

    <mat-tab-group [selectedIndex]="selectedTab()" (selectedTabChange)="onTabChange($event.index)">
      <!-- Prompts Tab -->
      <mat-tab label="Prompts">
        <div class="tab-content">
          <div class="filters">
            <mat-form-field>
              <mat-label>Group</mat-label>
              <mat-select [(ngModel)]="groupFilter" (ngModelChange)="applyPromptFilters()">
                <mat-option value="">All</mat-option>
                @for (g of groups(); track g) {
                  <mat-option [value]="g">{{ g }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Task Type</mat-label>
              <mat-select [(ngModel)]="taskTypeFilter" (ngModelChange)="loadPrompts()">
                <mat-option value="">All</mat-option>
                @for (t of taskTypes(); track t) {
                  <mat-option [value]="t">{{ t }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Search</mat-label>
              <input matInput [(ngModel)]="promptSearchFilter" (keyup.enter)="loadPrompts()">
            </mat-form-field>
          </div>

          <mat-card>
            <table mat-table [dataSource]="prompts()" class="full-width">
              <ng-container matColumnDef="group">
                <th mat-header-cell *matHeaderCellDef>Group</th>
                <td mat-cell *matCellDef="let p">
                  <span class="code-chip">{{ getGroup(p.key) }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="name">
                <th mat-header-cell *matHeaderCellDef>Name</th>
                <td mat-cell *matCellDef="let p">
                  <a [routerLink]="['/prompts', p.key]" class="link">{{ p.name }}</a>
                </td>
              </ng-container>

              <ng-container matColumnDef="taskType">
                <th mat-header-cell *matHeaderCellDef>Task Type</th>
                <td mat-cell *matCellDef="let p">{{ p.taskType }}</td>
              </ng-container>

              <ng-container matColumnDef="role">
                <th mat-header-cell *matHeaderCellDef>Role</th>
                <td mat-cell *matCellDef="let p">
                  <span class="role-chip role-{{ p.role.toLowerCase() }}">{{ p.role }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="overrides">
                <th mat-header-cell *matHeaderCellDef>Overrides</th>
                <td mat-cell *matCellDef="let p">
                  @if (p.overrideCount > 0) {
                    <span class="override-badge">{{ p.overrideCount }}</span>
                  } @else {
                    <span class="muted">0</span>
                  }
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="promptColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: promptColumns;" class="clickable-row" (click)="goToPrompt(row.key)"></tr>
            </table>
          </mat-card>

          @if (prompts().length === 0) {
            <p class="empty">No prompts match the current filter.</p>
          }
        </div>
      </mat-tab>

      <!-- Keywords Tab -->
      <mat-tab label="Keywords">
        <div class="tab-content">
          <div class="filters">
            <mat-form-field>
              <mat-label>Category</mat-label>
              <mat-select [(ngModel)]="categoryFilter" (ngModelChange)="loadKeywords()">
                <mat-option value="">All</mat-option>
                @for (c of categories(); track c) {
                  <mat-option [value]="c">{{ c }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field>
              <mat-label>Search</mat-label>
              <input matInput [(ngModel)]="keywordSearchFilter" (ngModelChange)="loadKeywords()">
            </mat-form-field>
            <button mat-raised-button color="primary" (click)="addKeyword()">
              <mat-icon>add</mat-icon> Add Keyword
            </button>
            <button mat-stroked-button (click)="seedKeywords()" [disabled]="seeding()">
              <mat-icon>{{ seeding() ? 'hourglass_empty' : 'auto_fix_high' }}</mat-icon>
              {{ seeding() ? 'Seeding...' : 'Seed Defaults' }}
            </button>
          </div>

          <mat-card>
            <table mat-table [dataSource]="keywords()" class="full-width">
              <ng-container matColumnDef="token">
                <th mat-header-cell *matHeaderCellDef>Token</th>
                <td mat-cell *matCellDef="let k">
                  <code class="token">{{ wrapToken(k.token) }}</code>
                </td>
              </ng-container>

              <ng-container matColumnDef="label">
                <th mat-header-cell *matHeaderCellDef>Label</th>
                <td mat-cell *matCellDef="let k">{{ k.label }}</td>
              </ng-container>

              <ng-container matColumnDef="category">
                <th mat-header-cell *matHeaderCellDef>Category</th>
                <td mat-cell *matCellDef="let k">
                  <span class="code-chip">{{ k.category }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="sampleValue">
                <th mat-header-cell *matHeaderCellDef>Sample Value</th>
                <td mat-cell *matCellDef="let k">
                  <span class="sample-value">{{ k.sampleValue ?? '-' }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let k">
                  <button mat-icon-button (click)="editKeyword(k); $event.stopPropagation()">
                    <mat-icon>edit</mat-icon>
                  </button>
                  <button mat-icon-button color="warn" (click)="deleteKeyword(k); $event.stopPropagation()">
                    <mat-icon>delete</mat-icon>
                  </button>
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="keywordColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: keywordColumns;"></tr>
            </table>
          </mat-card>

          @if (keywords().length === 0) {
            <p class="empty">No keywords match the current filters.</p>
          }
        </div>
      </mat-tab>

      <!-- AI Models Tab -->
      <mat-tab label="AI Tasks">
        <div class="tab-content">
          <div class="filters"></div>

          <mat-card>
            <table mat-table [dataSource]="mergedModelRows()" class="full-width">
              <ng-container matColumnDef="taskType">
                <th mat-header-cell *matHeaderCellDef>Task Type</th>
                <td mat-cell *matCellDef="let row">
                  @if (row.source === 'CLIENT') {
                    <span class="indent-client">
                      <mat-icon class="sub-row-icon">subdirectory_arrow_right</mat-icon>
                      <span class="client-label">{{ row.clientLabel }}</span>
                    </span>
                  } @else {
                    <span class="code-chip">{{ row.taskType }}</span>
                  }
                </td>
              </ng-container>

              <ng-container matColumnDef="provider">
                <th mat-header-cell *matHeaderCellDef>Provider</th>
                <td mat-cell *matCellDef="let row">
                  <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                </td>
              </ng-container>

              <ng-container matColumnDef="model">
                <th mat-header-cell *matHeaderCellDef>Model</th>
                <td mat-cell *matCellDef="let row">
                  <code class="model-name">{{ row.model }}</code>
                </td>
              </ng-container>

              <ng-container matColumnDef="status">
                <th mat-header-cell *matHeaderCellDef>Status</th>
                <td mat-cell *matCellDef="let row">
                  @if (row.isOverridden) {
                    <span class="source-badge source-override"
                      [matTooltip]="'Code default: ' + row.defaultProvider + ' / ' + row.defaultModel">
                      OVERRIDE
                    </span>
                  } @else if (row.source === 'CLIENT') {
                    <span class="source-badge source-client">CLIENT</span>
                    @if (!row.isActive) {
                      <span class="inactive-badge">INACTIVE</span>
                    }
                  } @else {
                    <span class="source-badge source-default">DEFAULT</span>
                    @if (row.configId && !row.isActive) {
                      <span class="inactive-badge"
                        [matTooltip]="'Has inactive override: ' + getInactiveOverrideLabel(row)">
                        OVERRIDE OFF
                      </span>
                    }
                  }
                </td>
              </ng-container>

              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let row">
                  @if (row.source === 'DEFAULT' && !row.configId && !row.isOverridden) {
                    <button mat-icon-button matTooltip="Add Override" (click)="addModelConfigForTask(row.taskType); $event.stopPropagation()">
                      <mat-icon>add</mat-icon>
                    </button>
                  }
                  @if (row.configId) {
                    <mat-slide-toggle
                      [checked]="row.isActive"
                      (change)="toggleModelConfigActiveById(row.configId, row.isActive)"
                      color="primary">
                    </mat-slide-toggle>
                    <button mat-icon-button (click)="editModelConfigById(row.configId); $event.stopPropagation()">
                      <mat-icon>edit</mat-icon>
                    </button>
                    <button mat-icon-button color="warn" (click)="deleteModelConfigById(row.configId); $event.stopPropagation()">
                      <mat-icon>delete</mat-icon>
                    </button>
                  }
                </td>
              </ng-container>

              <tr mat-header-row *matHeaderRowDef="modelColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: modelColumns;"
                  [class.override-row]="row.isOverridden"
                  [class.client-row]="row.source === 'CLIENT'"
                  [class.inactive-row]="row.configId && !row.isActive && row.source !== 'DEFAULT'"></tr>
            </table>
          </mat-card>

          @if (mergedModelRows().length === 0) {
            <p class="empty">Loading AI model configuration...</p>
          }
        </div>
      </mat-tab>

    </mat-tab-group>
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .tab-content { padding: 16px 0; }
    .filters { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }
    .full-width { width: 100%; }
    .link { text-decoration: none; color: #3f51b5; font-weight: 500; }
    .link:hover { text-decoration: underline; }
    .code-chip { font-size: 12px; padding: 2px 8px; background: #e8eaf6; border-radius: 4px; color: #3f51b5; font-family: monospace; }
    .role-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .role-system { background: #e3f2fd; color: #1565c0; }
    .role-user { background: #e8f5e9; color: #2e7d32; }
    .override-badge { background: #fff3e0; color: #e65100; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 12px; }
    .muted { color: #999; }
    .token { font-size: 13px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    .sample-value { font-size: 13px; color: #666; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
    .clickable-row { cursor: pointer; }
    .clickable-row:hover { background: #f5f5f5; }
    .empty { color: #999; padding: 16px; text-align: center; }
    .provider-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .provider-local { background: #e8f5e9; color: #2e7d32; }
    .provider-claude { background: #fce4ec; color: #c62828; }
    .model-name { font-size: 13px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    .source-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .source-default { background: #f5f5f5; color: #666; }
    .source-override { background: #e8eaf6; color: #3f51b5; cursor: help; }
    .source-client { background: #fff3e0; color: #e65100; }
    .inactive-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: #ffebee; color: #c62828; margin-left: 4px; cursor: help; }
    .override-row { background: #f3f0ff; }
    .client-row { background: #fff8e1; }
    .inactive-row { opacity: 0.5; }
    .indent-client { display: inline-flex; align-items: center; gap: 4px; padding-left: 8px; }
    .sub-row-icon { font-size: 16px; width: 16px; height: 16px; color: #999; }
    .client-label { font-size: 13px; color: #e65100; font-weight: 500; }
  `],
})
export class PromptListComponent implements OnInit {
  private promptService = inject(PromptService);
  private aiConfigService = inject(AiConfigService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  prompts = signal<PromptSummary[]>([]);
  private allPrompts = signal<PromptSummary[]>([]);
  keywords = signal<PromptKeyword[]>([]);
  taskTypes = signal<string[]>([]);
  categories = signal<string[]>([]);
  groups = signal<string[]>([]);

  // AI Models tab state
  modelDefaults = signal<TaskTypeDefault[]>([]);
  modelConfigs = signal<AiModelConfig[]>([]);
  mergedModelRows = signal<MergedModelRow[]>([]);

  selectedTab = signal(0);
  seeding = signal(false);

  taskTypeFilter = '';
  promptSearchFilter = '';
  groupFilter = '';
  categoryFilter = '';
  keywordSearchFilter = '';

  promptColumns = ['group', 'name', 'taskType', 'role', 'overrides'];
  keywordColumns = ['token', 'label', 'category', 'sampleValue', 'actions'];
  modelColumns = ['taskType', 'provider', 'model', 'status', 'actions'];

  ngOnInit(): void {
    const tabParam = this.route.snapshot.queryParamMap.get('tab');
    if (tabParam !== null) {
      const tab = Number(tabParam);
      if (Number.isInteger(tab) && tab >= 0 && tab <= 2) this.selectedTab.set(tab);
    }
    this.loadPrompts();
    this.loadKeywords();
    this.loadModelData();
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    this.router.navigate([], { queryParams: { tab: index }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  loadPrompts(): void {
    this.promptService.getPrompts({
      taskType: this.taskTypeFilter || undefined,
      search: this.promptSearchFilter || undefined,
    }).subscribe(prompts => {
      this.allPrompts.set(prompts);
      if (this.taskTypes().length === 0) {
        const types = [...new Set(prompts.map(p => p.taskType))].sort();
        this.taskTypes.set(types);
      }
      if (this.groups().length === 0) {
        const grps = [...new Set(prompts.map(p => this.getGroup(p.key)))].sort();
        this.groups.set(grps);
      }
      this.applyPromptFilters();
    });
  }

  applyPromptFilters(): void {
    let filtered = this.allPrompts();
    if (this.groupFilter) {
      filtered = filtered.filter(p => this.getGroup(p.key) === this.groupFilter);
    }
    this.prompts.set(filtered);
  }

  loadKeywords(): void {
    this.promptService.getKeywords({
      category: this.categoryFilter || undefined,
      search: this.keywordSearchFilter || undefined,
    }).subscribe(keywords => {
      this.keywords.set(keywords);
      if (this.categories().length === 0) {
        const cats = [...new Set(keywords.map(k => k.category))].sort();
        this.categories.set(cats);
      }
    });
  }

  wrapToken(token: string): string {
    return `{{${token}}}`;
  }

  getGroup(key: string): string {
    const prefix = key.split('.')[0];
    return prefix ?? key;
  }

  goToPrompt(key: string): void {
    this.router.navigate(['/prompts', key]);
  }

  addKeyword(): void {
    const ref = this.dialog.open(KeywordDialogComponent, {
      width: '500px',
      data: {},
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.loadKeywords();
    });
  }

  editKeyword(keyword: PromptKeyword): void {
    const ref = this.dialog.open(KeywordDialogComponent, {
      width: '500px',
      data: { keyword },
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.loadKeywords();
    });
  }

  seedKeywords(): void {
    this.seeding.set(true);
    this.promptService.seedKeywords().subscribe({
      next: (result) => {
        this.seeding.set(false);
        this.snackBar.open(`Seeded ${result.seeded} keywords`, 'OK', { duration: 3000 });
        this.loadKeywords();
      },
      error: (err) => {
        this.seeding.set(false);
        this.snackBar.open(err.error?.message ?? 'Failed to seed keywords', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }

  deleteKeyword(keyword: PromptKeyword): void {
    if (!confirm(`Delete keyword "{{${keyword.token}}}"?`)) return;
    this.promptService.deleteKeyword(keyword.id).subscribe({
      next: () => {
        this.snackBar.open('Keyword deleted', 'OK', { duration: 3000 });
        this.loadKeywords();
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Failed to delete keyword', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  // ─── AI Models ───────────────────────────────────────────────────────

  /**
   * Load both defaults and overrides, then merge into a single flat list.
   * For each task type the primary row shows the effective config (APP_WIDE
   * override if active, otherwise the hardcoded default). CLIENT-scoped
   * overrides appear as indented sub-rows beneath their task type.
   */
  loadModelData(): void {
    forkJoin({
      defaults: this.aiConfigService.getDefaults(),
      configs: this.aiConfigService.getConfigs(),
    }).subscribe(({ defaults, configs }) => {
      this.modelDefaults.set(defaults);
      this.modelConfigs.set(configs);
      this.rebuildMergedRows();
    });
  }

  /**
   * Build a single flat list with one primary row per task type showing
   * the effective setting, followed by any CLIENT sub-rows.
   *
   * - Active APP_WIDE override → replaces default values, flagged as overridden
   * - Inactive APP_WIDE override → shows default values, references override for actions
   * - No APP_WIDE override → shows default values, no actions on primary row
   * - CLIENT overrides → indented sub-rows beneath the task type
   */
  private rebuildMergedRows(): void {
    const defaults = this.modelDefaults();
    const configs = this.modelConfigs();
    if (defaults.length === 0) return;

    const rows: MergedModelRow[] = [];

    for (const d of defaults) {
      const overrides = configs.filter(c => c.taskType === d.taskType);
      const appWide = overrides.find(c => c.scope === 'APP_WIDE');
      const clientOverrides = overrides.filter(c => c.scope === 'CLIENT');

      if (appWide?.isActive) {
        // Active APP_WIDE override replaces the default row
        rows.push({
          taskType: d.taskType,
          provider: appWide.provider,
          model: appWide.model,
          source: 'APP_WIDE',
          configId: appWide.id,
          isActive: true,
          clientLabel: null,
          isOverridden: true,
          defaultProvider: d.provider,
          defaultModel: d.model,
        });
      } else if (appWide && !appWide.isActive) {
        // Inactive APP_WIDE override — show default but reference the override
        rows.push({
          taskType: d.taskType,
          provider: d.provider,
          model: d.model,
          source: 'DEFAULT',
          configId: appWide.id,
          isActive: false,
          clientLabel: null,
          isOverridden: false,
          defaultProvider: d.provider,
          defaultModel: d.model,
        });
      } else {
        // No APP_WIDE override — pure default
        rows.push({
          taskType: d.taskType,
          provider: d.provider,
          model: d.model,
          source: 'DEFAULT',
          configId: null,
          isActive: true,
          clientLabel: null,
          isOverridden: false,
          defaultProvider: d.provider,
          defaultModel: d.model,
        });
      }

      // CLIENT overrides as sub-rows
      for (const c of clientOverrides) {
        rows.push({
          taskType: d.taskType,
          provider: c.provider,
          model: c.model,
          source: 'CLIENT',
          configId: c.id,
          isActive: c.isActive,
          clientLabel: c.client ? `${c.client.name} (${c.client.shortCode})` : c.clientId ?? '—',
          isOverridden: false,
          defaultProvider: d.provider,
          defaultModel: d.model,
        });
      }
    }

    this.mergedModelRows.set(rows);
  }

  addModelConfigForTask(taskType: string): void {
    const ref = this.dialog.open(AiConfigDialogComponent, {
      width: '500px',
      data: {
        taskType,
        taskTypes: this.modelDefaults().map(d => d.taskType),
      },
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.loadModelData();
    });
  }

  addModelConfig(): void {
    if (this.modelDefaults().length === 0) {
      this.snackBar.open('Model defaults not loaded yet', 'OK', { duration: 3000 });
      return;
    }
    const ref = this.dialog.open(AiConfigDialogComponent, {
      width: '500px',
      data: {
        taskTypes: this.modelDefaults().map(d => d.taskType),
      },
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.loadModelData();
    });
  }

  editModelConfigById(configId: string): void {
    const config = this.modelConfigs().find(c => c.id === configId);
    if (!config) return;
    const codeDefault = this.modelDefaults().find(d => d.taskType === config.taskType);
    const ref = this.dialog.open(AiConfigDialogComponent, {
      width: '500px',
      data: {
        config,
        taskTypes: this.modelDefaults().map(d => d.taskType),
        codeDefault: codeDefault ? { provider: codeDefault.provider, model: codeDefault.model } : undefined,
      },
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.loadModelData();
    });
  }

  toggleModelConfigActiveById(configId: string, currentlyActive: boolean): void {
    this.aiConfigService.update(configId, { isActive: !currentlyActive }).subscribe({
      next: () => {
        this.snackBar.open(`Config ${currentlyActive ? 'deactivated' : 'activated'}`, 'OK', { duration: 3000 });
        this.loadModelData();
      },
      error: () => this.snackBar.open('Failed to update config', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  getInactiveOverrideLabel(row: MergedModelRow): string {
    const config = this.modelConfigs().find(c => c.id === row.configId);
    if (!config) return '';
    return `${config.provider} / ${config.model}`;
  }

  deleteModelConfigById(configId: string): void {
    if (!confirm('Delete this model config override?')) return;
    this.aiConfigService.delete(configId).subscribe({
      next: () => {
        this.snackBar.open('Config deleted', 'OK', { duration: 3000 });
        this.loadModelData();
      },
      error: () => this.snackBar.open('Failed to delete config', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

}
