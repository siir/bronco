import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { PromptService, PromptSummary, PromptKeyword } from '../../core/services/prompt.service';
import { AiConfigService, TaskTypeDefault, AiModelConfig } from '../../core/services/ai-config.service';
import { forkJoin } from 'rxjs';
import { KeywordDialogComponent } from './keyword-dialog.component';
import { AiConfigDialogComponent } from './ai-config-dialog.component';
import {
  BroncoButtonComponent,
  SelectComponent,
  TextInputComponent,
  ToggleSwitchComponent,
  TabGroupComponent,
  TabComponent,
  DataTableComponent,
  DataTableColumnComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

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
  imports: [
    RouterLink,
    FormsModule,
    MatDialogModule,
    BroncoButtonComponent,
    SelectComponent,
    TextInputComponent,
    ToggleSwitchComponent,
    TabGroupComponent,
    TabComponent,
    DataTableComponent,
    DataTableColumnComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1>AI Prompts</h1>
      </div>

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">
        <!-- Prompts Tab -->
        <app-tab label="Prompts">
          <div class="tab-content">
            <div class="filters">
              <app-select
                [value]="groupFilter"
                [options]="groupOptions()"
                placeholder=""
                (valueChange)="groupFilter = $event; applyPromptFilters()">
              </app-select>
              <app-select
                [value]="taskTypeFilter"
                [options]="taskTypeOptions()"
                placeholder=""
                (valueChange)="taskTypeFilter = $event; loadPrompts()">
              </app-select>
              <app-text-input
                [value]="promptSearchFilter"
                placeholder="Search prompts..."
                (valueChange)="promptSearchFilter = $event"
                (keyup.enter)="loadPrompts()">
              </app-text-input>
            </div>

            <div class="table-card">
              <app-data-table [data]="prompts()" [trackBy]="trackByKey" [rowClickable]="true" (rowClick)="goToPrompt($event.key)" emptyMessage="No prompts match the current filter.">
                <app-data-column key="group" header="Group" [sortable]="false">
                  <ng-template #cell let-p>
                    <span class="code-chip">{{ getGroup(p.key) }}</span>
                  </ng-template>
                </app-data-column>

                <app-data-column key="name" header="Name" [sortable]="false">
                  <ng-template #cell let-p>
                    <a class="link" [routerLink]="['/prompts', p.key]">{{ p.name }}</a>
                  </ng-template>
                </app-data-column>

                <app-data-column key="taskType" header="Task Type" [sortable]="false">
                  <ng-template #cell let-p>
                    <span class="task-type-text">{{ p.taskType }}</span>
                  </ng-template>
                </app-data-column>

                <app-data-column key="role" header="Role" [sortable]="false">
                  <ng-template #cell let-p>
                    <span class="role-chip role-{{ p.role.toLowerCase() }}">{{ p.role }}</span>
                  </ng-template>
                </app-data-column>

                <app-data-column key="overrides" header="Overrides" [sortable]="false" width="80px">
                  <ng-template #cell let-p>
                    @if (p.overrideCount > 0) {
                      <span class="override-badge">{{ p.overrideCount }}</span>
                    } @else {
                      <span class="muted">0</span>
                    }
                  </ng-template>
                </app-data-column>
              </app-data-table>
            </div>
          </div>
        </app-tab>

        <!-- Keywords Tab -->
        <app-tab label="Keywords">
          <div class="tab-content">
            <div class="filters">
              <app-select
                [value]="categoryFilter"
                [options]="categoryOptions()"
                placeholder=""
                (valueChange)="categoryFilter = $event; loadKeywords()">
              </app-select>
              <app-text-input
                [value]="keywordSearchFilter"
                placeholder="Search keywords..."
                (valueChange)="keywordSearchFilter = $event; loadKeywords()">
              </app-text-input>
              <app-bronco-button variant="primary" (click)="addKeyword()">+ Add Keyword</app-bronco-button>
              <app-bronco-button variant="secondary" [disabled]="seeding()" (click)="seedKeywords()">
                {{ seeding() ? 'Seeding...' : 'Seed Defaults' }}
              </app-bronco-button>
            </div>

            <div class="table-card">
              <app-data-table [data]="keywords()" [trackBy]="trackKeywordById" [rowClickable]="false" emptyMessage="No keywords match the current filters.">
                <app-data-column key="token" header="Token" [sortable]="false">
                  <ng-template #cell let-k>
                    <code class="token">{{ wrapToken(k.token) }}</code>
                  </ng-template>
                </app-data-column>

                <app-data-column key="label" header="Label" [sortable]="false">
                  <ng-template #cell let-k>{{ k.label }}</ng-template>
                </app-data-column>

                <app-data-column key="category" header="Category" [sortable]="false">
                  <ng-template #cell let-k>
                    <span class="code-chip">{{ k.category }}</span>
                  </ng-template>
                </app-data-column>

                <app-data-column key="sampleValue" header="Sample Value" [sortable]="false">
                  <ng-template #cell let-k>
                    <span class="sample-value">{{ k.sampleValue ?? '-' }}</span>
                  </ng-template>
                </app-data-column>

                <app-data-column key="actions" header="" [sortable]="false" width="120px">
                  <ng-template #cell let-k>
                    <div class="action-btns">
                      <app-bronco-button variant="ghost" size="sm" (click)="editKeyword(k); $event.stopPropagation()">Edit</app-bronco-button>
                      <app-bronco-button variant="destructive" size="sm" (click)="deleteKeyword(k); $event.stopPropagation()">Delete</app-bronco-button>
                    </div>
                  </ng-template>
                </app-data-column>
              </app-data-table>
            </div>
          </div>
        </app-tab>

        <!-- AI Tasks Tab -->
        <app-tab label="AI Tasks">
          <div class="tab-content">
            <div class="table-card">
              <app-data-table [data]="mergedModelRows()" [trackBy]="trackModelRow" [rowClickable]="false" emptyMessage="Loading AI model configuration...">
                <app-data-column key="taskType" header="Task Type" [sortable]="false">
                  <ng-template #cell let-row>
                    @if (row.source === 'CLIENT') {
                      <span class="indent-client">
                        <span class="sub-row-arrow">&#x21B3;</span>
                        <span class="client-label">{{ row.clientLabel }}</span>
                      </span>
                    } @else {
                      <span class="code-chip">{{ row.taskType }}</span>
                    }
                  </ng-template>
                </app-data-column>

                <app-data-column key="provider" header="Provider" [sortable]="false">
                  <ng-template #cell let-row>
                    <span class="provider-chip provider-{{ row.provider.toLowerCase() }}">{{ row.provider }}</span>
                  </ng-template>
                </app-data-column>

                <app-data-column key="model" header="Model" [sortable]="false">
                  <ng-template #cell let-row>
                    <code class="model-name">{{ row.model }}</code>
                  </ng-template>
                </app-data-column>

                <app-data-column key="status" header="Status" [sortable]="false">
                  <ng-template #cell let-row>
                    @if (row.isOverridden) {
                      <span class="source-badge source-override"
                        [title]="'Code default: ' + row.defaultProvider + ' / ' + row.defaultModel">
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
                          [title]="'Has inactive override: ' + getInactiveOverrideLabel(row)">
                          OVERRIDE OFF
                        </span>
                      }
                    }
                  </ng-template>
                </app-data-column>

                <app-data-column key="actions" header="" [sortable]="false" width="200px">
                  <ng-template #cell let-row>
                    <div class="action-btns">
                      @if (row.source === 'DEFAULT' && !row.configId && !row.isOverridden) {
                        <app-bronco-button variant="ghost" size="sm" title="Add Override" (click)="addModelConfigForTask(row.taskType); $event.stopPropagation()">+ Override</app-bronco-button>
                      }
                      @if (row.configId) {
                        <app-toggle-switch
                          [checked]="row.isActive"
                          (checkedChange)="toggleModelConfigActiveById(row.configId, row.isActive)">
                        </app-toggle-switch>
                        <app-bronco-button variant="ghost" size="sm" (click)="editModelConfigById(row.configId); $event.stopPropagation()">Edit</app-bronco-button>
                        <app-bronco-button variant="destructive" size="sm" (click)="deleteModelConfigById(row.configId); $event.stopPropagation()">Delete</app-bronco-button>
                      }
                    </div>
                  </ng-template>
                </app-data-column>
              </app-data-table>
            </div>
          </div>
        </app-tab>
      </app-tab-group>
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .page-header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
      font-family: var(--font-primary);
      color: var(--text-primary);
      letter-spacing: -0.28px;
      line-height: 1.14;
    }
    .tab-content { padding: 16px 0; }
    .filters {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      align-items: center;
      flex-wrap: wrap;
    }
    .table-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      overflow: hidden;
    }
    .link {
      text-decoration: none;
      color: var(--accent-link);
      font-weight: 500;
      font-family: var(--font-primary);
    }
    .link:hover { text-decoration: underline; }
    .code-chip {
      font-size: 12px;
      padding: 2px 8px;
      background: rgba(0, 113, 227, 0.08);
      border-radius: var(--radius-sm);
      color: var(--accent);
      font-family: monospace;
    }
    .task-type-text {
      font-size: 13px;
      color: var(--text-secondary);
      font-family: var(--font-primary);
    }
    .role-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
    }
    .role-system { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .role-user { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .override-badge {
      background: rgba(255, 149, 0, 0.1);
      color: var(--color-warning);
      font-size: 12px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-pill);
    }
    .muted { color: var(--text-tertiary); }
    .token {
      font-size: 13px;
      background: var(--bg-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }
    .sample-value {
      font-size: 13px;
      color: var(--text-tertiary);
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: inline-block;
    }
    .action-btns { display: flex; gap: 4px; align-items: center; }
    .provider-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-muted);
      color: var(--text-secondary);
    }
    .provider-local { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .provider-claude { background: rgba(255, 59, 48, 0.08); color: var(--color-error); }
    .provider-openai { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .provider-grok { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .provider-google { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .model-name {
      font-size: 13px;
      background: var(--bg-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }
    .source-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
    }
    .source-default { background: var(--bg-muted); color: var(--text-tertiary); }
    .source-override { background: rgba(0, 113, 227, 0.08); color: var(--accent); cursor: help; }
    .source-client { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .inactive-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      background: rgba(255, 59, 48, 0.08);
      color: var(--color-error);
      margin-left: 4px;
      cursor: help;
    }
    .indent-client {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding-left: 8px;
    }
    .sub-row-arrow {
      font-size: 14px;
      color: var(--text-tertiary);
    }
    .client-label {
      font-size: 13px;
      color: var(--color-warning);
      font-weight: 500;
      font-family: var(--font-primary);
    }
  `],
})
export class PromptListComponent implements OnInit {
  private promptService = inject(PromptService);
  private aiConfigService = inject(AiConfigService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private dialog = inject(MatDialog);
  private toast = inject(ToastService);

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

  groupOptions = signal<Array<{ value: string; label: string }>>([{ value: '', label: 'All' }]);
  taskTypeOptions = signal<Array<{ value: string; label: string }>>([{ value: '', label: 'All' }]);
  categoryOptions = signal<Array<{ value: string; label: string }>>([{ value: '', label: 'All' }]);

  trackByKey = (p: PromptSummary) => p.key;
  trackKeywordById = (k: PromptKeyword) => k.id;
  trackModelRow = (row: MergedModelRow) => (row.configId ?? row.taskType) + row.source + (row.clientLabel ?? '');

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
        this.taskTypeOptions.set([
          { value: '', label: 'All' },
          ...types.map(t => ({ value: t, label: t })),
        ]);
      }
      if (this.groups().length === 0) {
        const grps = [...new Set(prompts.map(p => this.getGroup(p.key)))].sort();
        this.groups.set(grps);
        this.groupOptions.set([
          { value: '', label: 'All' },
          ...grps.map(g => ({ value: g, label: g })),
        ]);
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
        this.categoryOptions.set([
          { value: '', label: 'All' },
          ...cats.map(c => ({ value: c, label: c })),
        ]);
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
        this.toast.info(`Seeded ${result.seeded} keywords`);
        this.loadKeywords();
      },
      error: (err) => {
        this.seeding.set(false);
        this.toast.error(err.error?.message ?? 'Failed to seed keywords');
      },
    });
  }

  deleteKeyword(keyword: PromptKeyword): void {
    if (!confirm(`Delete keyword "{{${keyword.token}}}"?`)) return;
    this.promptService.deleteKeyword(keyword.id).subscribe({
      next: () => {
        this.toast.success('Keyword deleted');
        this.loadKeywords();
      },
      error: (err) => this.toast.error(err.error?.message ?? 'Failed to delete keyword'),
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
      this.toast.info('Model defaults not loaded yet');
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
        this.toast.success(`Config ${currentlyActive ? 'deactivated' : 'activated'}`);
        this.loadModelData();
      },
      error: () => this.toast.error('Failed to update config'),
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
        this.toast.success('Config deleted');
        this.loadModelData();
      },
      error: () => this.toast.error('Failed to delete config'),
    });
  }

}
