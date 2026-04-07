import { Component, inject, OnInit, signal, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';
import { TicketRouteService, TicketRouteStep, RouteStepTypeInfo, DispatchPreviewEntry, WithWarnings } from '../../core/services/ticket-route.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-ticket-route-step-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <app-form-field label="Step Type">
      <select class="select-native" [(ngModel)]="stepType" (change)="onStepTypeChange()" [disabled]="isEdit">
        <option value="" disabled>Select step type...</option>
        <optgroup label="Ingestion Steps">
          @for (st of ingestionTypes(); track st.type) {
            <option [value]="st.type">{{ st.name }}</option>
          }
        </optgroup>
        <optgroup label="Analysis Steps">
          @for (st of analysisTypes(); track st.type) {
            <option [value]="st.type">{{ st.name }}</option>
          }
        </optgroup>
        <optgroup label="Dispatch Steps">
          @for (st of dispatchTypes(); track st.type) {
            <option [value]="st.type">{{ st.name }}</option>
          }
        </optgroup>
      </select>
    </app-form-field>

    @if (selectedInfo()) {
      <p class="step-desc">{{ selectedInfo()!.description }}</p>
      @if (selectedInfo()!.defaultTaskType) {
        <p class="step-defaults">
          Default task: <code>{{ selectedInfo()!.defaultTaskType }}</code>
          @if (selectedInfo()!.defaultPromptKey) {
            · Prompt: <code>{{ selectedInfo()!.defaultPromptKey }}</code>
          }
        </p>
      }
    }

    <app-form-field label="Name">
      <app-text-input
        [value]="name"
        placeholder="Display name for this step"
        (valueChange)="name = $event" />
    </app-form-field>

    <app-form-field label="Step Order">
      <app-text-input
        [value]="stepOrder.toString()"
        type="number"
        (valueChange)="stepOrder = +$event >= 0 ? +$event : 0" />
    </app-form-field>

    @if (selectedInfo()?.defaultTaskType) {
      <app-form-field label="Task Type Override">
        <app-text-input
          [value]="taskTypeOverride"
          placeholder="e.g. BUG_ANALYSIS"
          (valueChange)="taskTypeOverride = $event" />
      </app-form-field>

      <app-form-field label="Prompt Key Override">
        <app-text-input
          [value]="promptKeyOverride"
          placeholder="e.g. custom.analysis.system"
          (valueChange)="promptKeyOverride = $event" />
      </app-form-field>
    }

    @if (stepType === 'ADD_FOLLOWER') {
      <h4 class="config-heading">Add Follower Config</h4>
      <app-form-field label="Email Address">
        <app-text-input
          [value]="followerEmail"
          type="email"
          placeholder="user@example.com"
          (valueChange)="followerEmail = $event" />
      </app-form-field>

      <app-form-field label="Email Domain">
        <app-text-input
          [value]="followerEmailDomain"
          placeholder="example.com"
          (valueChange)="followerEmailDomain = $event" />
      </app-form-field>

      <app-form-field label="Follower Type">
        <app-select
          [value]="followerType"
          [options]="followerTypeOptions"
          (valueChange)="followerType = $event === 'REQUESTER' ? 'REQUESTER' : 'FOLLOWER'" />
      </app-form-field>
    }

    @if (stepType === 'AGENTIC_ANALYSIS') {
      <h4 class="config-heading">Agentic Analysis Config</h4>
      <app-form-field label="Max Iterations">
        <app-text-input
          [value]="agenticMaxIterations.toString()"
          type="number"
          (valueChange)="agenticMaxIterations = +$event >= 1 ? (+$event > 50 ? 50 : +$event) : 1" />
      </app-form-field>

      <app-form-field label="System Prompt Override">
        <app-textarea
          [value]="agenticSystemPromptOverride"
          [rows]="3"
          placeholder="Additional instructions appended to the default system prompt"
          (valueChange)="agenticSystemPromptOverride = $event" />
      </app-form-field>
    }

    @if (stepType === 'CUSTOM_AI_QUERY') {
      <h4 class="config-heading">Custom AI Query Config</h4>
      <app-form-field label="Prompt / Instructions">
        <app-textarea
          [value]="customQueryPrompt"
          [rows]="5"
          placeholder="Write custom instructions for the AI query..."
          (valueChange)="customQueryPrompt = $event" />
      </app-form-field>

      <h4 class="subsection-heading">Include Pipeline Context</h4>
      <div class="context-checkboxes">
        <label class="checkbox-item"><input type="checkbox" class="form-checkbox" [(ngModel)]="customIncludeTicket"> Ticket info (subject, body, category, priority)</label>
        <label class="checkbox-item"><input type="checkbox" class="form-checkbox" [(ngModel)]="customIncludeClientContext"> Client context (from Load Client Context step)</label>
        <label class="checkbox-item"><input type="checkbox" class="form-checkbox" [(ngModel)]="customIncludeCodeContext"> Code context (from Gather Repo Context step)</label>
        <label class="checkbox-item"><input type="checkbox" class="form-checkbox" [(ngModel)]="customIncludeDbContext"> Database context (from Gather DB Context step)</label>
        <label class="checkbox-item"><input type="checkbox" class="form-checkbox" [(ngModel)]="customIncludeFacts"> Extracted facts (from Extract Facts step)</label>
        <label class="checkbox-item"><input type="checkbox" class="form-checkbox" [(ngModel)]="customIncludeAnalysis"> Prior analysis results</label>
      </div>

      <h4 class="subsection-heading">Fresh MCP Queries (optional)</h4>
      <div class="queries-list">
        @for (mq of customMcpQueries; track $index) {
          <div class="query-row">
            <div class="query-tool-field">
              <app-select
                [value]="mq.toolName"
                [options]="mcpToolOptions"
                (valueChange)="mq.toolName = $event" />
            </div>
            <div class="query-params-field">
              <app-textarea
                [value]="mq.paramsJson"
                [rows]="1"
                placeholder='{"query": "SELECT ..."}'
                (valueChange)="mq.paramsJson = $event" />
            </div>
            <app-bronco-button variant="icon" ariaLabel="Remove" (click)="removeCustomMcpQuery($index)">×</app-bronco-button>
          </div>
        }
        <app-bronco-button variant="ghost" (click)="addCustomMcpQuery()">+ Add MCP Query</app-bronco-button>
      </div>

      <h4 class="subsection-heading">Fresh Repo Searches (optional)</h4>
      <div class="queries-list">
        @for (rs of customRepoSearches; track $index) {
          <div class="query-row repo-row">
            <div class="query-tool-field">
              <app-text-input
                [value]="rs.repoName"
                placeholder="(all repos if blank)"
                (valueChange)="rs.repoName = $event" />
            </div>
            <div class="query-params-field">
              <app-text-input
                [value]="rs.searchTerms"
                placeholder="term1, term2"
                (valueChange)="rs.searchTerms = $event" />
            </div>
            <div class="query-params-field">
              <app-text-input
                [value]="rs.filePaths"
                placeholder="src/foo.ts, src/bar.ts"
                (valueChange)="rs.filePaths = $event" />
            </div>
            <app-bronco-button variant="icon" ariaLabel="Remove" (click)="removeCustomRepoSearch($index)">×</app-bronco-button>
          </div>
        }
        <app-bronco-button variant="ghost" (click)="addCustomRepoSearch()">+ Add Repo Search</app-bronco-button>
      </div>
    }

    @if (stepType === 'DISPATCH_TO_ROUTE') {
      <h4 class="config-heading">Dispatch Configuration</h4>

      <div class="mode-group">
        <label><input type="radio" [(ngModel)]="dispatchMode" value="auto"> Auto-resolve</label>
        <label><input type="radio" [(ngModel)]="dispatchMode" value="pin"> Pin to route</label>
        <label><input type="radio" [(ngModel)]="dispatchMode" value="rules"> Conditional rules</label>
      </div>

      @if (dispatchMode === 'pin') {
        <app-form-field label="Target Route">
          <app-select
            [value]="dispatchTargetRouteId"
            [options]="dispatchTargetRouteOptions"
            (valueChange)="dispatchTargetRouteId = $event" />
        </app-form-field>
      }

      @if (dispatchMode === 'rules') {
        <div class="rules-list">
          @for (rule of dispatchRules; track $index) {
            <div class="rule-row">
              <div class="rule-field">
                <app-select
                  [value]="rule.category"
                  [options]="categorySelectOptions"
                  (valueChange)="rule.category = $event" />
              </div>
              <div class="rule-field">
                <app-select
                  [value]="rule.targetRouteId"
                  [options]="availableRouteOptions"
                  (valueChange)="rule.targetRouteId = $event" />
              </div>
              <app-bronco-button variant="icon" ariaLabel="Remove" (click)="removeRule($index)">×</app-bronco-button>
            </div>
          }
          <app-bronco-button variant="ghost" (click)="addRule()">+ Add Rule</app-bronco-button>
        </div>

        <app-form-field label="When no rule matches">
          <app-select
            [value]="dispatchFallback"
            [options]="dispatchFallbackOptions"
            (valueChange)="dispatchFallback = $event === 'stop' ? 'stop' : 'auto'" />
        </app-form-field>
      }

      <div class="preview-panel">
        <h4 class="preview-heading">Resolution Preview</h4>
        @if (dispatchMode === 'pin' && dispatchTargetRouteId) {
          <p class="preview-pin">Always dispatches to: <strong>{{ getRouteName(dispatchTargetRouteId) }}</strong></p>
        } @else if (dispatchMode === 'pin') {
          <p class="preview-muted">Select a target route above</p>
        } @else {
          <table class="preview-table">
            <thead><tr><th>Category</th><th>Would dispatch to</th><th>Scope</th></tr></thead>
            <tbody>
              @for (entry of dispatchPreview; track entry.category) {
                <tr>
                  <td>{{ entry.category }}</td>
                  <td [class.muted]="!entry.routeName">{{ entry.routeName ?? 'No match — continues current route' }}</td>
                  <td>{{ entry.routeId ? (entry.clientScoped ? 'Client' : 'Global') : '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
    }

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" (click)="save()" [disabled]="!stepType || !name.trim() || saving || (stepType === 'CUSTOM_AI_QUERY' && !customQueryPrompt.trim()) || (stepType === 'ADD_FOLLOWER' && !followerEmail.trim() && !followerEmailDomain.trim())">
        {{ saving ? 'Saving...' : (isEdit ? 'Update' : 'Add') }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .step-desc { font-size: 13px; color: #555; margin: 0 0 12px; padding: 8px 12px; background: #f5f5f5; border-radius: 6px; }
    .step-defaults { font-size: 12px; color: #777; margin: -4px 0 12px; }
    .step-defaults code { font-size: 11px; background: #e8eaf6; padding: 1px 4px; border-radius: 3px; color: #3f51b5; }
    .config-heading { font-size: 14px; font-weight: 500; margin: 12px 0 8px; color: #333; border-top: 1px solid #e0e0e0; padding-top: 12px; }
    .mode-group { display: flex; gap: 16px; margin-bottom: 16px; }
    .mode-group label { font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .rules-list { margin-bottom: 12px; }
    .rule-row { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
    .rule-field { flex: 1; }
    .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; vertical-align: middle; }
    .badge.cat { background: #e8eaf6; color: #3f51b5; }
    .badge.scope { background: #e8f5e9; color: #2e7d32; }
    .preview-panel { background: #fafafa; border: 1px solid #e0e0e0; border-radius: 6px; padding: 12px; margin-top: 12px; }
    .preview-heading { font-size: 13px; font-weight: 500; margin: 0 0 8px; color: #555; }
    .preview-pin { font-size: 13px; margin: 0; }
    .preview-muted { font-size: 13px; color: #999; margin: 0; }
    .muted { color: #999; }
    .preview-table { width: 100%; font-size: 12px; border-collapse: collapse; }
    .preview-table th { text-align: left; font-weight: 500; color: #666; padding: 4px 8px; border-bottom: 1px solid #e0e0e0; }
    .preview-table td { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; }
    .subsection-heading { font-size: 13px; font-weight: 500; margin: 8px 0 6px; color: #555; }
    .context-checkboxes { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .checkbox-item { font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
    .form-checkbox { cursor: pointer; }
    .queries-list { margin-bottom: 12px; }
    .query-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 4px; }
    .query-row.repo-row { flex-wrap: wrap; }
    .query-tool-field { flex: 0 0 180px; }
    .query-params-field { flex: 1; min-width: 150px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .select-native {
      width: 100%;
      box-sizing: border-box;
      appearance: none;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 32px 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      cursor: pointer;
      outline: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
    }
    .select-native:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--focus-ring, rgba(0, 113, 227, 0.15)); }
    .select-native:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class TicketRouteStepDialogComponent implements OnInit {
  private routeService = inject(TicketRouteService);
  private toast = inject(ToastService);

  routeId = input.required<string>();
  step = input<TicketRouteStep>();
  stepTypes = input.required<RouteStepTypeInfo[]>();
  nextOrder = input<number>();

  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;

  ingestionTypes = signal<RouteStepTypeInfo[]>([]);
  analysisTypes = signal<RouteStepTypeInfo[]>([]);
  dispatchTypes = signal<RouteStepTypeInfo[]>([]);
  selectedInfo = signal<RouteStepTypeInfo | null>(null);

  stepType = '';
  name = '';
  stepOrder = 1;
  taskTypeOverride = '';
  promptKeyOverride = '';
  saving = false;

  // Add Follower config
  followerEmail = '';
  followerEmailDomain = '';
  followerType: 'REQUESTER' | 'FOLLOWER' = 'FOLLOWER';

  // Agentic analysis config
  agenticMaxIterations = 10;
  agenticSystemPromptOverride = '';

  // Custom AI Query config
  customQueryPrompt = '';
  customIncludeTicket = false;
  customIncludeClientContext = false;
  customIncludeCodeContext = false;
  customIncludeDbContext = false;
  customIncludeFacts = false;
  customIncludeAnalysis = false;
  customMcpQueries: Array<{ toolName: string; paramsJson: string }> = [];
  customRepoSearches: Array<{ repoName: string; searchTerms: string; filePaths: string }> = [];
  mcpToolNames = ['run_query', 'inspect_schema', 'list_indexes', 'get_blocking_tree', 'get_wait_stats', 'get_database_health'];

  // Dispatch config
  dispatchMode: 'auto' | 'pin' | 'rules' = 'auto';
  dispatchTargetRouteId = '';
  dispatchRules: Array<{ category: string; targetRouteId: string }> = [];
  dispatchFallback: 'auto' | 'stop' = 'auto';

  // Data for dropdowns and preview
  availableRoutes: Array<{ id: string; name: string; category: string | null; clientId: string | null }> = [];
  dispatchPreview: DispatchPreviewEntry[] = [];
  categoryValues = ['DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE', 'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL'];

  get followerTypeOptions() { return [{ value: 'FOLLOWER', label: 'Follower' }, { value: 'REQUESTER', label: 'Requester' }]; }
  get mcpToolOptions() { return this.mcpToolNames.map(t => ({ value: t, label: t })); }
  get categorySelectOptions() { return this.categoryValues.map(c => ({ value: c, label: c })); }
  get availableRouteOptions() { return this.availableRoutes.map(r => ({ value: r.id, label: r.name + (r.category ? ` [${r.category}]` : '') + (r.clientId ? ' [Client]' : ' [Global]') })); }
  get dispatchFallbackOptions() { return [{ value: 'auto', label: 'Auto-resolve' }, { value: 'stop', label: 'Continue current route' }]; }
  get dispatchTargetRouteOptions() { return this.availableRoutes.map(r => ({ value: r.id, label: r.name + (r.category ? ` [${r.category}]` : '') + (r.clientId ? ' [Client]' : ' [Global]') })); }

  ngOnInit(): void {
    const types = this.stepTypes();
    this.ingestionTypes.set(types.filter((t) => t.phase === 'ingestion'));
    this.analysisTypes.set(types.filter((t) => t.phase === 'analysis'));
    this.dispatchTypes.set(types.filter((t) => t.phase === 'dispatch'));

    const s = this.step();
    this.isEdit = !!s;
    this.stepType = s?.stepType ?? '';
    this.name = s?.name ?? '';
    this.stepOrder = s?.stepOrder ?? this.nextOrder() ?? 1;
    this.taskTypeOverride = s?.taskTypeOverride ?? '';
    this.promptKeyOverride = s?.promptKeyOverride ?? '';

    if (this.stepType) {
      this.selectedInfo.set(types.find((t) => t.type === this.stepType) ?? null);
    }

    // Extract config from existing step
    if (s) {
      const cfg = s.config as Record<string, unknown> | null;
      if (cfg) {
        // Add Follower
        const email = cfg['email'];
        this.followerEmail = typeof email === 'string' ? email : '';
        const emailDomain = cfg['emailDomain'];
        this.followerEmailDomain = typeof emailDomain === 'string' ? emailDomain : '';
        this.followerType = cfg['followerType'] === 'REQUESTER' ? 'REQUESTER' : 'FOLLOWER';

        // Agentic analysis
        this.agenticMaxIterations = (cfg['maxIterations'] as number) ?? 10;
        this.agenticSystemPromptOverride = (cfg['systemPromptOverride'] as string) ?? '';

        // Custom AI Query
        this.customQueryPrompt = (cfg['prompt'] as string) ?? '';
        const includeCtx = (cfg['includeContext'] ?? {}) as Record<string, boolean>;
        this.customIncludeTicket = includeCtx['ticket'] ?? false;
        this.customIncludeClientContext = includeCtx['clientContext'] ?? false;
        this.customIncludeCodeContext = includeCtx['codeContext'] ?? false;
        this.customIncludeDbContext = includeCtx['dbContext'] ?? false;
        this.customIncludeFacts = includeCtx['facts'] ?? false;
        this.customIncludeAnalysis = includeCtx['analysis'] ?? false;

        const rawMcpQueries = cfg['mcpQueries'];
        if (Array.isArray(rawMcpQueries)) {
          this.customMcpQueries = rawMcpQueries.map((q: any) => ({
            toolName: q.toolName ?? '',
            paramsJson: q.params ? JSON.stringify(q.params) : '',
          }));
        }

        const rawRepoSearches = cfg['repoSearches'];
        if (Array.isArray(rawRepoSearches)) {
          this.customRepoSearches = rawRepoSearches.map((rs: any) => ({
            repoName: rs.repoName ?? '',
            searchTerms: Array.isArray(rs.searchTerms) ? rs.searchTerms.join(', ') : '',
            filePaths: Array.isArray(rs.filePaths) ? rs.filePaths.join(', ') : '',
          }));
        }

        // Dispatch config
        if (this.stepType === 'DISPATCH_TO_ROUTE') {
          this.dispatchMode = (cfg['mode'] as 'auto' | 'pin' | 'rules') ?? 'auto';
          this.dispatchTargetRouteId = (cfg['targetRouteId'] as string) ?? '';
          this.dispatchRules = Array.isArray(cfg['rules']) ? (cfg['rules'] as Array<{ category: string; targetRouteId: string }>) : [];
          this.dispatchFallback = (cfg['fallback'] as 'auto' | 'stop') ?? 'auto';
        }
      }
    }

    if (this.stepType === 'DISPATCH_TO_ROUTE') {
      this.loadDispatchData();
    }
  }

  onStepTypeChange(): void {
    const types = this.stepTypes();
    const info = types.find((t) => t.type === this.stepType);
    this.selectedInfo.set(info ?? null);
    if (info && !this.name) {
      this.name = info.name;
    }
    if (this.stepType === 'DISPATCH_TO_ROUTE') {
      this.loadDispatchData();
    }
  }

  addCustomMcpQuery(): void {
    this.customMcpQueries = [...this.customMcpQueries, { toolName: '', paramsJson: '' }];
  }

  removeCustomMcpQuery(index: number): void {
    this.customMcpQueries = this.customMcpQueries.filter((_, i) => i !== index);
  }

  addCustomRepoSearch(): void {
    this.customRepoSearches = [...this.customRepoSearches, { repoName: '', searchTerms: '', filePaths: '' }];
  }

  removeCustomRepoSearch(index: number): void {
    this.customRepoSearches = this.customRepoSearches.filter((_, i) => i !== index);
  }

  addRule(): void {
    this.dispatchRules = [...this.dispatchRules, { category: '', targetRouteId: '' }];
  }

  removeRule(index: number): void {
    this.dispatchRules = this.dispatchRules.filter((_, i) => i !== index);
  }

  getRouteName(routeId: string): string {
    return this.availableRoutes.find((r) => r.id === routeId)?.name ?? '(unknown)';
  }

  private loadDispatchData(): void {
    const rid = this.routeId();
    this.routeService.getRoutes({ isActive: 'true' }).subscribe((routes) => {
      this.availableRoutes = routes
        .filter((r: any) => r.id !== rid)
        .map((r: any) => ({ id: r.id, name: r.name, category: r.category, clientId: r.clientId }));
    });
    this.routeService.getRoute(rid).subscribe((route: any) => {
      this.routeService.getDispatchPreview(rid, route.clientId ?? undefined).subscribe((preview) => {
        this.dispatchPreview = preview.categories;
      });
    });
  }

  private buildStepConfig(): Record<string, unknown> | undefined {
    if (this.stepType === 'ADD_FOLLOWER') {
      const config: Record<string, unknown> = {};
      if (this.followerEmail.trim()) config['email'] = this.followerEmail.trim();
      else if (this.followerEmailDomain.trim()) config['emailDomain'] = this.followerEmailDomain.trim();
      if (this.followerType !== 'FOLLOWER') config['followerType'] = this.followerType;
      return Object.keys(config).length > 0 ? config : undefined;
    }

    if (this.stepType === 'AGENTIC_ANALYSIS') {
      const config: Record<string, unknown> = {};
      if (this.agenticMaxIterations !== 10) config['maxIterations'] = this.agenticMaxIterations;
      if (this.agenticSystemPromptOverride.trim()) config['systemPromptOverride'] = this.agenticSystemPromptOverride.trim();
      return Object.keys(config).length > 0 ? config : undefined;
    }

    if (this.stepType === 'CUSTOM_AI_QUERY') {
      const config: Record<string, unknown> = { prompt: this.customQueryPrompt.trim() };

      const includeContext: Record<string, boolean> = {};
      if (this.customIncludeTicket) includeContext['ticket'] = true;
      if (this.customIncludeClientContext) includeContext['clientContext'] = true;
      if (this.customIncludeCodeContext) includeContext['codeContext'] = true;
      if (this.customIncludeDbContext) includeContext['dbContext'] = true;
      if (this.customIncludeFacts) includeContext['facts'] = true;
      if (this.customIncludeAnalysis) includeContext['analysis'] = true;
      if (Object.keys(includeContext).length > 0) config['includeContext'] = includeContext;

      const mcpQueries = this.customMcpQueries
        .filter((q) => q.toolName)
        .map((q) => {
          const entry: Record<string, unknown> = { toolName: q.toolName };
          if (q.paramsJson.trim()) {
            try { entry['params'] = JSON.parse(q.paramsJson); } catch { /* invalid JSON ignored */ }
          }
          return entry;
        });
      if (mcpQueries.length > 0) config['mcpQueries'] = mcpQueries;

      const repoSearches = this.customRepoSearches
        .filter((s) => s.searchTerms.trim() || s.filePaths.trim())
        .map((s) => {
          const entry: Record<string, unknown> = {};
          if (s.repoName.trim()) entry['repoName'] = s.repoName.trim();
          if (s.searchTerms.trim()) entry['searchTerms'] = s.searchTerms.split(',').map((t) => t.trim()).filter(Boolean);
          if (s.filePaths.trim()) entry['filePaths'] = s.filePaths.split(',').map((t) => t.trim()).filter(Boolean);
          return entry;
        });
      if (repoSearches.length > 0) config['repoSearches'] = repoSearches;

      return config;
    }

    if (this.stepType === 'DISPATCH_TO_ROUTE') {
      const config: Record<string, unknown> = { mode: this.dispatchMode };
      if (this.dispatchMode === 'pin' && this.dispatchTargetRouteId) {
        config['targetRouteId'] = this.dispatchTargetRouteId;
      }
      if (this.dispatchMode === 'rules' && this.dispatchRules.length > 0) {
        config['rules'] = this.dispatchRules.filter((r) => r.category && r.targetRouteId);
        if (this.dispatchFallback !== 'auto') config['fallback'] = this.dispatchFallback;
      }
      return config;
    }

    return undefined;
  }

  save(): void {
    if (!this.stepType || !this.name.trim()) return;
    this.saving = true;
    const config = this.buildStepConfig();
    const rid = this.routeId();

    if (this.isEdit) {
      const updatePayload: Record<string, unknown> = {
        name: this.name.trim(),
        stepOrder: this.stepOrder,
        taskTypeOverride: this.taskTypeOverride.trim() || null,
        promptKeyOverride: this.promptKeyOverride.trim() || null,
      };
      if (this.stepType === 'ADD_FOLLOWER' || this.stepType === 'AGENTIC_ANALYSIS' || this.stepType === 'DISPATCH_TO_ROUTE' || this.stepType === 'CUSTOM_AI_QUERY') {
        updatePayload['config'] = config ?? null;
      }
      this.routeService.updateStep(rid, this.step()!.id, updatePayload).subscribe({
        next: (result: WithWarnings<TicketRouteStep>) => {
          if (result.warnings.length > 0) {
            this.toast.warning(result.warnings[0]);
          } else {
            this.toast.success('Step updated');
          }
          this.saved.emit(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.message ?? 'Failed to update step');
        },
      });
    } else {
      this.routeService.addStep(rid, {
        name: this.name.trim(),
        stepType: this.stepType,
        stepOrder: this.stepOrder,
        taskTypeOverride: this.taskTypeOverride.trim() || undefined,
        promptKeyOverride: this.promptKeyOverride.trim() || undefined,
        config,
      }).subscribe({
        next: (result: WithWarnings<TicketRouteStep>) => {
          if (result.warnings.length > 0) {
            this.toast.warning(result.warnings[0]);
          } else {
            this.toast.success('Step added');
          }
          this.saved.emit(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.message ?? 'Failed to add step');
        },
      });
    }
  }
}
