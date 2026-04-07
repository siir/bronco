import { Component, inject, OnInit, signal, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatRadioModule } from '@angular/material/radio';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TicketRouteService, TicketRouteStep, RouteStepTypeInfo, DispatchPreviewEntry, WithWarnings } from '../../core/services/ticket-route.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-ticket-route-step-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatRadioModule, MatIconModule, MatCheckboxModule],
  template: `
    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Step Type</mat-label>
      <mat-select [(ngModel)]="stepType" (selectionChange)="onStepTypeChange()" [disabled]="isEdit">
        <mat-optgroup label="Ingestion Steps">
          @for (st of ingestionTypes(); track st.type) {
            <mat-option [value]="st.type">{{ st.name }}</mat-option>
          }
        </mat-optgroup>
        <mat-optgroup label="Analysis Steps">
          @for (st of analysisTypes(); track st.type) {
            <mat-option [value]="st.type">{{ st.name }}</mat-option>
          }
        </mat-optgroup>
        <mat-optgroup label="Dispatch Steps">
          @for (st of dispatchTypes(); track st.type) {
            <mat-option [value]="st.type">{{ st.name }}</mat-option>
          }
        </mat-optgroup>
      </mat-select>
    </mat-form-field>

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

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="name" required placeholder="Display name for this step">
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Step Order</mat-label>
      <input matInput type="number" [(ngModel)]="stepOrder" min="0" required>
      <mat-hint>Execution order within the route (lower = earlier).</mat-hint>
    </mat-form-field>

    @if (selectedInfo()?.defaultTaskType) {
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Task Type Override</mat-label>
        <input matInput [(ngModel)]="taskTypeOverride" placeholder="e.g. BUG_ANALYSIS">
        <mat-hint>Leave empty to use the step's default AI task type.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Prompt Key Override</mat-label>
        <input matInput [(ngModel)]="promptKeyOverride" placeholder="e.g. custom.analysis.system">
        <mat-hint>Leave empty to use the step's default prompt key.</mat-hint>
      </mat-form-field>
    }

    @if (stepType === 'ADD_FOLLOWER') {
      <h4 class="config-heading">Add Follower Config</h4>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Email Address</mat-label>
        <input matInput type="email" [(ngModel)]="followerEmail" placeholder="user@example.com">
        <mat-hint>Exact email address to add as follower. Leave empty to use Email Domain instead.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Email Domain</mat-label>
        <input matInput [(ngModel)]="followerEmailDomain" placeholder="example.com">
        <mat-hint>Match all contacts with this domain (e.g. "acme.com"). Ignored if Email Address is set.</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Follower Type</mat-label>
        <mat-select [(ngModel)]="followerType">
          <mat-option value="FOLLOWER">Follower</mat-option>
          <mat-option value="REQUESTER">Requester</mat-option>
        </mat-select>
        <mat-hint>REQUESTER is the primary contact; FOLLOWER receives notifications.</mat-hint>
      </mat-form-field>
    }

    @if (stepType === 'AGENTIC_ANALYSIS') {
      <h4 class="config-heading">Agentic Analysis Config</h4>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Max Iterations</mat-label>
        <input matInput type="number" [(ngModel)]="agenticMaxIterations" min="1" max="50">
        <mat-hint>Maximum tool-use loop iterations (default: 10).</mat-hint>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>System Prompt Override</mat-label>
        <textarea matInput [(ngModel)]="agenticSystemPromptOverride" rows="3"
          placeholder="Additional instructions appended to the default system prompt"></textarea>
        <mat-hint>Optional. Appended to the built-in investigation prompt.</mat-hint>
      </mat-form-field>
    }

    @if (stepType === 'CUSTOM_AI_QUERY') {
      <h4 class="config-heading">Custom AI Query Config</h4>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Prompt / Instructions</mat-label>
        <textarea matInput [(ngModel)]="customQueryPrompt" rows="5" required
          placeholder="Write custom instructions for the AI query..."></textarea>
        <mat-hint>The prompt sent to the AI. Context sources selected below are prepended automatically.</mat-hint>
      </mat-form-field>

      <h4 class="subsection-heading">Include Pipeline Context</h4>
      <div class="context-checkboxes">
        <mat-checkbox [(ngModel)]="customIncludeTicket">Ticket info (subject, body, category, priority)</mat-checkbox>
        <mat-checkbox [(ngModel)]="customIncludeClientContext">Client context (from Load Client Context step)</mat-checkbox>
        <mat-checkbox [(ngModel)]="customIncludeCodeContext">Code context (from Gather Repo Context step)</mat-checkbox>
        <mat-checkbox [(ngModel)]="customIncludeDbContext">Database context (from Gather DB Context step)</mat-checkbox>
        <mat-checkbox [(ngModel)]="customIncludeFacts">Extracted facts (from Extract Facts step)</mat-checkbox>
        <mat-checkbox [(ngModel)]="customIncludeAnalysis">Prior analysis results</mat-checkbox>
      </div>

      <h4 class="subsection-heading">Fresh MCP Queries (optional)</h4>
      <div class="queries-list">
        @for (mq of customMcpQueries; track $index) {
          <div class="query-row">
            <mat-form-field class="query-tool-field">
              <mat-label>Tool</mat-label>
              <mat-select [(ngModel)]="mq.toolName">
                @for (t of mcpToolNames; track t) {
                  <mat-option [value]="t">{{ t }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field class="query-params-field">
              <mat-label>Params (JSON)</mat-label>
              <textarea matInput [(ngModel)]="mq.paramsJson" rows="1"
                placeholder='{"query": "SELECT ..."}' ></textarea>
            </mat-form-field>
            <button mat-icon-button color="warn" aria-label="Remove query" (click)="removeCustomMcpQuery($index)"><mat-icon>delete</mat-icon></button>
          </div>
        }
        <button mat-button (click)="addCustomMcpQuery()">+ Add MCP Query</button>
      </div>

      <h4 class="subsection-heading">Fresh Repo Searches (optional)</h4>
      <div class="queries-list">
        @for (rs of customRepoSearches; track $index) {
          <div class="query-row repo-row">
            <mat-form-field class="query-tool-field">
              <mat-label>Repo Name</mat-label>
              <input matInput [(ngModel)]="rs.repoName" placeholder="(all repos if blank)">
            </mat-form-field>
            <mat-form-field class="query-params-field">
              <mat-label>Search Terms</mat-label>
              <input matInput [(ngModel)]="rs.searchTerms" placeholder="term1, term2">
              <mat-hint>Comma-separated git grep terms.</mat-hint>
            </mat-form-field>
            <mat-form-field class="query-params-field">
              <mat-label>File Paths</mat-label>
              <input matInput [(ngModel)]="rs.filePaths" placeholder="src/foo.ts, src/bar.ts">
              <mat-hint>Comma-separated file paths to read.</mat-hint>
            </mat-form-field>
            <button mat-icon-button color="warn" aria-label="Remove search" (click)="removeCustomRepoSearch($index)"><mat-icon>delete</mat-icon></button>
          </div>
        }
        <button mat-button (click)="addCustomRepoSearch()">+ Add Repo Search</button>
      </div>
    }

    @if (stepType === 'DISPATCH_TO_ROUTE') {
      <h4 class="config-heading">Dispatch Configuration</h4>

      <mat-radio-group [(ngModel)]="dispatchMode" class="mode-group">
        <mat-radio-button value="auto">Auto-resolve</mat-radio-button>
        <mat-radio-button value="pin">Pin to route</mat-radio-button>
        <mat-radio-button value="rules">Conditional rules</mat-radio-button>
      </mat-radio-group>

      @if (dispatchMode === 'pin') {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Target Route</mat-label>
          <mat-select [(ngModel)]="dispatchTargetRouteId">
            @for (r of availableRoutes; track r.id) {
              <mat-option [value]="r.id">
                {{ r.name }}
                @if (r.category) { <span class="badge cat">{{ r.category }}</span> }
                <span class="badge scope">{{ r.clientId ? 'Client' : 'Global' }}</span>
              </mat-option>
            }
          </mat-select>
        </mat-form-field>
      }

      @if (dispatchMode === 'rules') {
        <div class="rules-list">
          @for (rule of dispatchRules; track $index) {
            <div class="rule-row">
              <mat-form-field class="rule-field">
                <mat-label>Category</mat-label>
                <mat-select [(ngModel)]="rule.category">
                  @for (cat of categoryValues; track cat) {
                    <mat-option [value]="cat">{{ cat }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field class="rule-field">
                <mat-label>Route</mat-label>
                <mat-select [(ngModel)]="rule.targetRouteId">
                  @for (r of availableRoutes; track r.id) {
                    <mat-option [value]="r.id">{{ r.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <button mat-icon-button color="warn" aria-label="Remove rule" (click)="removeRule($index)"><mat-icon>delete</mat-icon></button>
            </div>
          }
          <button mat-button (click)="addRule()">+ Add Rule</button>
        </div>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>When no rule matches</mat-label>
          <mat-select [(ngModel)]="dispatchFallback">
            <mat-option value="auto">Auto-resolve</mat-option>
            <mat-option value="stop">Continue current route</mat-option>
          </mat-select>
        </mat-form-field>
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
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!stepType || !name.trim() || saving || (stepType === 'CUSTOM_AI_QUERY' && !customQueryPrompt.trim()) || (stepType === 'ADD_FOLLOWER' && !followerEmail.trim() && !followerEmailDomain.trim())">
        {{ saving ? 'Saving...' : (isEdit ? 'Update' : 'Add') }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .step-desc { font-size: 13px; color: #555; margin: 0 0 12px; padding: 8px 12px; background: #f5f5f5; border-radius: 6px; }
    .step-defaults { font-size: 12px; color: #777; margin: -4px 0 12px; }
    .step-defaults code { font-size: 11px; background: #e8eaf6; padding: 1px 4px; border-radius: 3px; color: #3f51b5; }
    .config-heading { font-size: 14px; font-weight: 500; margin: 12px 0 8px; color: #333; border-top: 1px solid #e0e0e0; padding-top: 12px; }
    .mode-group { display: flex; gap: 16px; margin-bottom: 16px; }
    .mode-group mat-radio-button { font-size: 13px; }
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
    .context-checkboxes mat-checkbox { font-size: 13px; }
    .queries-list { margin-bottom: 12px; }
    .query-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 4px; }
    .query-row.repo-row { flex-wrap: wrap; }
    .query-tool-field { flex: 0 0 180px; }
    .query-params-field { flex: 1; min-width: 150px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
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
