import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { PromptService, PromptSummary, PromptKeyword } from '../../core/services/prompt.service.js';
import { AiConfigService, TaskTypeDefault, AiModelConfig } from '../../core/services/ai-config.service.js';
import { forkJoin } from 'rxjs';
import { KeywordDialogComponent } from './keyword-dialog.component.js';
import { AiConfigDialogComponent } from './ai-config-dialog.component.js';
import {
  BroncoButtonComponent,
  SelectComponent,
  TextInputComponent,
  ToggleSwitchComponent,
  TabGroupComponent,
  TabComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
  IconComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service.js';

const TAB_LABELS = ['Prompts', 'Keywords', 'AI Tasks'] as const;

interface MergedModelRow {
  taskType: string;
  provider: string;
  model: string;
  maxTokens: number | null;
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
    BroncoButtonComponent,
    SelectComponent,
    TextInputComponent,
    ToggleSwitchComponent,
    TabGroupComponent,
    TabComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    KeywordDialogComponent,
    AiConfigDialogComponent,
    IconComponent,
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
                (valueChange)="groupFilter = $event; applyPromptFilters()">
              </app-select>
              <app-select
                [value]="taskTypeFilter"
                [options]="taskTypeOptions()"
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
                (valueChange)="categoryFilter = $event; loadKeywords()">
              </app-select>
              <app-text-input
                [value]="keywordSearchFilter"
                placeholder="Search keywords..."
                (valueChange)="keywordSearchFilter = $event; loadKeywords()">
              </app-text-input>
              <app-bronco-button variant="primary" (click)="showKeywordDialog.set(true)">+ Add Keyword</app-bronco-button>
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
                        <app-icon name="subdirectory" size="sm" class="sub-row-arrow" />
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
                    @if (row.maxTokens) { <span class="max-tokens-chip">max {{ row.maxTokens }}</span> }
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

    @if (showKeywordDialog()) {
      <app-dialog [open]="true" [title]="editingKeyword() ? 'Edit Keyword' : 'Add Keyword'" maxWidth="500px" (openChange)="showKeywordDialog.set(false)">
        <app-keyword-dialog-content
          [keyword]="editingKeyword() ?? undefined"
          (saved)="onKeywordSaved()"
          (cancelled)="showKeywordDialog.set(false)" />
      </app-dialog>
    }

    @if (showAiConfigDialog()) {
      <app-dialog [open]="true" [title]="editingConfig() ? 'Edit AI Model Config' : 'Add AI Model Config'" maxWidth="500px" (openChange)="showAiConfigDialog.set(false)">
        <app-ai-config-dialog-content
          [config]="editingConfig() ?? undefined"
          [presetTaskType]="configPresetTaskType()"
          [taskTypes]="modelTaskTypes()"
          [codeDefault]="configCodeDefault() ?? undefined"
          (saved)="onConfigSaved()"
          (cancelled)="showAiConfigDialog.set(false)" />
      </app-dialog>
    }
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
    .max-tokens-chip {
      font-size: 11px;
      color: var(--text-tertiary);
      margin-left: 6px;
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
  modelTaskTypes = computed(() => this.modelDefaults().map(d => d.taskType));

  selectedTab = signal(0);
  seeding = signal(false);

  // Dialog state
  showKeywordDialog = signal(false);
  editingKeyword = signal<PromptKeyword | null>(null);
  showAiConfigDialog = signal(false);
  editingConfig = signal<AiModelConfig | null>(null);
  configPresetTaskType = signal<string | undefined>(undefined);
  configCodeDefault = signal<{ provider: string; model: string } | null>(null);

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
    const tabSlug = this.route.snapshot.queryParamMap.get('tab');
    if (tabSlug) {
      const idx = TAB_LABELS.findIndex(l => this.toSlug(l) === tabSlug);
      if (idx >= 0) this.selectedTab.set(idx);
    }
    this.loadPrompts();
    this.loadKeywords();
    this.loadModelData();
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    const slug = this.toSlug(TAB_LABELS[index] ?? '');
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: slug || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private toSlug(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
    this.editingKeyword.set(null);
    this.showKeywordDialog.set(true);
  }

  editKeyword(keyword: PromptKeyword): void {
    this.editingKeyword.set(keyword);
    this.showKeywordDialog.set(true);
  }

  onKeywordSaved(): void {
    this.showKeywordDialog.set(false);
    this.loadKeywords();
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
        rows.push({
          taskType: d.taskType,
          provider: appWide.provider,
          model: appWide.model,
          maxTokens: appWide.maxTokens,
          source: 'APP_WIDE',
          configId: appWide.id,
          isActive: true,
          clientLabel: null,
          isOverridden: true,
          defaultProvider: d.provider,
          defaultModel: d.model,
        });
      } else if (appWide && !appWide.isActive) {
        rows.push({
          taskType: d.taskType,
          provider: d.provider,
          model: d.model,
          maxTokens: null,
          source: 'DEFAULT',
          configId: appWide.id,
          isActive: false,
          clientLabel: null,
          isOverridden: false,
          defaultProvider: d.provider,
          defaultModel: d.model,
        });
      } else {
        rows.push({
          taskType: d.taskType,
          provider: d.provider,
          model: d.model,
          maxTokens: null,
          source: 'DEFAULT',
          configId: null,
          isActive: true,
          clientLabel: null,
          isOverridden: false,
          defaultProvider: d.provider,
          defaultModel: d.model,
        });
      }

      for (const c of clientOverrides) {
        rows.push({
          taskType: d.taskType,
          provider: c.provider,
          model: c.model,
          maxTokens: c.maxTokens,
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
    this.editingConfig.set(null);
    this.configPresetTaskType.set(taskType);
    this.configCodeDefault.set(null);
    this.showAiConfigDialog.set(true);
  }

  addModelConfig(): void {
    if (this.modelDefaults().length === 0) {
      this.toast.info('Model defaults not loaded yet');
      return;
    }
    this.editingConfig.set(null);
    this.configPresetTaskType.set(undefined);
    this.configCodeDefault.set(null);
    this.showAiConfigDialog.set(true);
  }

  editModelConfigById(configId: string): void {
    const config = this.modelConfigs().find(c => c.id === configId);
    if (!config) return;
    const codeDefault = this.modelDefaults().find(d => d.taskType === config.taskType);
    this.editingConfig.set(config);
    this.configPresetTaskType.set(undefined);
    this.configCodeDefault.set(codeDefault ? { provider: codeDefault.provider, model: codeDefault.model } : null);
    this.showAiConfigDialog.set(true);
  }

  onConfigSaved(): void {
    this.showAiConfigDialog.set(false);
    this.loadModelData();
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
    const base = `${config.provider} / ${config.model}`;
    return config.maxTokens ? `${base} (max ${config.maxTokens})` : base;
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
