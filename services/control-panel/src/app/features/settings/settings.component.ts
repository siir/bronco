import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  ExternalServiceService,
  ExternalService,
} from '../../core/services/external-service.service';
import { UserService, ControlPanelUser } from '../../core/services/user.service';
import {
  SettingsService,
  TicketStatusConfig,
  TicketCategoryConfig,
  SelfAnalysisConfig,
} from '../../core/services/settings.service';
import { ExternalServiceDialogComponent } from './external-service-dialog.component';
import { StatusConfigDialogComponent } from './status-config-dialog.component';
import { CategoryConfigDialogComponent } from './category-config-dialog.component';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
  SelectComponent,
  ToggleSwitchComponent,
  TabComponent,
  TabGroupComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DropdownMenuComponent,
  DropdownItemComponent,
  DialogComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

const TAB_LABELS = ['General', 'Ticket Statuses', 'Ticket Categories', 'External Services', 'Action Safety', 'Analysis Strategy', 'Self Analysis'] as const;

@Component({
  standalone: true,
  imports: [
    FormsModule,
    BroncoButtonComponent,
    CardComponent,
    FormFieldComponent,
    SelectComponent,
    ToggleSwitchComponent,
    TabComponent,
    TabGroupComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DropdownMenuComponent,
    DropdownItemComponent,
    DialogComponent,
    ExternalServiceDialogComponent,
    StatusConfigDialogComponent,
    CategoryConfigDialogComponent,
  ],
  template: `
    <div class="page-wrapper">
      <h1 class="page-title">Settings</h1>

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">
        <!-- General tab -->
        <app-tab label="General">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">API Configuration</h2>
              <p class="hint">The API key is stored in session storage (cleared when tab closes) and sent with every request.</p>
              <div class="form-grid">
                <app-form-field label="API Key">
                  <div class="input-with-toggle">
                    <input class="text-input" [type]="showKey() ? 'text' : 'password'" [(ngModel)]="apiKey">
                    <button class="toggle-vis" (click)="showKey.set(!showKey())" title="Toggle visibility">
                      {{ showKey() ? 'Hide' : 'Show' }}
                    </button>
                  </div>
                </app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveKey()">
                  Save API Key
                </app-bronco-button>
                <app-bronco-button variant="destructive" size="sm" (click)="clearKey()">Clear</app-bronco-button>
              </div>
            </app-card>

            <app-card>
              <h2 class="section-title">Super Admin</h2>
              <p class="hint">Designate a control panel user as the super admin. This user will have elevated privileges for system-wide operations.</p>
              <div class="form-grid">
                <app-form-field label="Super Admin User">
                  <app-select
                    [value]="superAdminUserId ?? ''"
                    [options]="superAdminOptions()"
                    [disabled]="usersLoading()"
                    placeholder="-- None --"
                    (valueChange)="superAdminUserId = $event || null" />
                </app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveSuperAdmin()" [disabled]="superAdminSaving()">
                  @if (superAdminSaving()) { Saving... } @else { Save }
                </app-bronco-button>
              </div>
            </app-card>
          </div>
        </app-tab>

        <!-- Ticket Statuses tab -->
        <app-tab label="Ticket Statuses">
          <div class="tab-content">
            <div class="section-header">
              <div>
                <h2 class="section-title">Ticket Statuses</h2>
                <p class="hint">
                  Configure how ticket statuses appear and behave. Each status belongs to either the
                  <strong>open</strong> class (active tickets) or the <strong>closed</strong> class (terminal tickets).
                </p>
              </div>
              <app-bronco-button variant="primary" (click)="createStatus()">Create Status</app-bronco-button>
            </div>

            @if (statusesLoading()) {
              <div class="empty-state"><span class="loading-text">Loading status configurations...</span></div>
            } @else if (statusesError()) {
              <div class="empty-state">
                <p>Failed to load status configurations.</p>
                <app-bronco-button variant="ghost" (click)="loadStatuses()">Retry</app-bronco-button>
              </div>
            } @else {
              <app-data-table [data]="statuses()" [trackBy]="trackStatus" [rowClickable]="false">
                <app-data-column key="color" header="Color" [sortable]="false" width="60px">
                  <ng-template #cell let-s>
                    <div class="color-swatch" [style.background]="s.color"></div>
                  </ng-template>
                </app-data-column>
                <app-data-column key="value" header="Value" [sortable]="false">
                  <ng-template #cell let-s><code>{{ s.value }}</code></ng-template>
                </app-data-column>
                <app-data-column key="displayName" header="Display Name" [sortable]="false">
                  <ng-template #cell let-s>{{ s.displayName }}</ng-template>
                </app-data-column>
                <app-data-column key="description" header="Description" [sortable]="false">
                  <ng-template #cell let-s><span class="desc-text">{{ s.description ?? '—' }}</span></ng-template>
                </app-data-column>
                <app-data-column key="statusClass" header="Class" [sortable]="false" width="100px">
                  <ng-template #cell let-s>
                    <span class="class-chip" [class.class-open]="s.statusClass === 'open'" [class.class-closed]="s.statusClass === 'closed'">
                      {{ s.statusClass }}
                    </span>
                  </ng-template>
                </app-data-column>
                <app-data-column key="sortOrder" header="Order" [sortable]="false" width="70px">
                  <ng-template #cell let-s>{{ s.sortOrder }}</ng-template>
                </app-data-column>
                <app-data-column key="active" header="Active" [sortable]="false" width="70px">
                  <ng-template #cell let-s>
                    <span [class.status-yes]="s.isActive" [class.status-no]="!s.isActive">
                      {{ s.isActive ? 'Yes' : 'No' }}
                    </span>
                  </ng-template>
                </app-data-column>
                <app-data-column key="actions" header="" [sortable]="false" width="60px">
                  <ng-template #cell let-s>
                    <app-bronco-button variant="icon" size="sm" title="Edit" (click)="editStatus(s)">
                      Edit
                    </app-bronco-button>
                  </ng-template>
                </app-data-column>
              </app-data-table>
            }
          </div>
        </app-tab>

        <!-- Ticket Categories tab -->
        <app-tab label="Ticket Categories">
          <div class="tab-content">
            <div class="section-header">
              <div>
                <h2 class="section-title">Ticket Categories</h2>
                <p class="hint">
                  Configure ticket categories used for classifying and organizing tickets.
                  Categories help route tickets to the right workflow.
                </p>
              </div>
              <app-bronco-button variant="primary" (click)="createCategory()">Create Category</app-bronco-button>
            </div>

            @if (categoriesLoading()) {
              <div class="empty-state"><span class="loading-text">Loading category configurations...</span></div>
            } @else if (categoriesError()) {
              <div class="empty-state">
                <p>Failed to load category configurations.</p>
                <app-bronco-button variant="ghost" (click)="loadCategories()">Retry</app-bronco-button>
              </div>
            } @else {
              <app-data-table [data]="categories()" [trackBy]="trackCategory" [rowClickable]="false">
                <app-data-column key="color" header="Color" [sortable]="false" width="60px">
                  <ng-template #cell let-c>
                    <div class="color-swatch" [style.background]="c.color"></div>
                  </ng-template>
                </app-data-column>
                <app-data-column key="value" header="Value" [sortable]="false">
                  <ng-template #cell let-c><code>{{ c.value }}</code></ng-template>
                </app-data-column>
                <app-data-column key="displayName" header="Display Name" [sortable]="false">
                  <ng-template #cell let-c>{{ c.displayName }}</ng-template>
                </app-data-column>
                <app-data-column key="description" header="Description" [sortable]="false">
                  <ng-template #cell let-c><span class="desc-text">{{ c.description ?? '—' }}</span></ng-template>
                </app-data-column>
                <app-data-column key="sortOrder" header="Order" [sortable]="false" width="70px">
                  <ng-template #cell let-c>{{ c.sortOrder }}</ng-template>
                </app-data-column>
                <app-data-column key="active" header="Active" [sortable]="false" width="70px">
                  <ng-template #cell let-c>
                    <span [class.status-yes]="c.isActive" [class.status-no]="!c.isActive">
                      {{ c.isActive ? 'Yes' : 'No' }}
                    </span>
                  </ng-template>
                </app-data-column>
                <app-data-column key="actions" header="" [sortable]="false" width="60px">
                  <ng-template #cell let-c>
                    <app-bronco-button variant="icon" size="sm" title="Edit" (click)="editCategory(c)">
                      Edit
                    </app-bronco-button>
                  </ng-template>
                </app-data-column>
              </app-data-table>
            }
          </div>
        </app-tab>

        <!-- External Services tab -->
        <app-tab label="External Services">
          <div class="tab-content">
            <div class="section-header">
              <div>
                <h2 class="section-title">External Services</h2>
                <p class="hint">
                  Configure external services to monitor on the System Status page.
                  Services like Ollama, reverse proxies, or other health endpoints can be tracked here.
                </p>
              </div>
              <app-bronco-button variant="primary" (click)="addService()">Add Service</app-bronco-button>
            </div>

            @if (services().length === 0) {
              <div class="empty-state">
                <p>No external services configured.</p>
                <p class="hint">Add services like Ollama or other endpoints to monitor them on the System Status page.</p>
              </div>
            } @else {
              <app-data-table [data]="services()" [trackBy]="trackService" [rowClickable]="false">
                <app-data-column key="name" header="Name" [sortable]="false">
                  <ng-template #cell let-svc>{{ svc.name }}</ng-template>
                </app-data-column>
                <app-data-column key="endpoint" header="Endpoint" [sortable]="false">
                  <ng-template #cell let-svc>
                    <span class="endpoint-text" [title]="svc.endpoint">{{ truncate(svc.endpoint, 40) }}</span>
                  </ng-template>
                </app-data-column>
                <app-data-column key="checkType" header="Check Type" [sortable]="false" width="120px">
                  <ng-template #cell let-svc>
                    <span class="check-type-chip">{{ svc.checkType }}</span>
                  </ng-template>
                </app-data-column>
                <app-data-column key="monitored" header="Monitored" [sortable]="false" width="100px">
                  <ng-template #cell let-svc>
                    <span [class.status-yes]="svc.isMonitored" [class.status-no]="!svc.isMonitored">
                      {{ svc.isMonitored ? 'Yes' : 'No' }}
                    </span>
                  </ng-template>
                </app-data-column>
                <app-data-column key="actions" header="" [sortable]="false" width="60px">
                  <ng-template #cell let-svc>
                    <app-bronco-button variant="icon" size="sm" title="Actions" #svcTrigger (click)="svcMenu.toggle()">
                      ...
                    </app-bronco-button>
                    <app-dropdown-menu #svcMenu [trigger]="svcTrigger">
                      <app-dropdown-item (action)="editService(svc)">Edit</app-dropdown-item>
                      <app-dropdown-item (action)="toggleMonitored(svc)">
                        {{ svc.isMonitored ? 'Disable Monitoring' : 'Enable Monitoring' }}
                      </app-dropdown-item>
                      <app-dropdown-item (action)="deleteService(svc)" [destructive]="true">Delete</app-dropdown-item>
                    </app-dropdown-menu>
                  </ng-template>
                </app-data-column>
              </app-data-table>
            }
          </div>
        </app-tab>

        <!-- Action Safety tab -->
        <app-tab label="Action Safety">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">AI Action Safety</h2>
              <p class="hint">
                Configure which AI-recommended actions are auto-executed and which require operator approval.
                Unknown action types always default to requiring approval.
              </p>

              @if (actionSafetyLoading()) {
                <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
              } @else {
                <app-data-table [data]="actionSafetyRows()" [trackBy]="trackActionSafety" [rowClickable]="false">
                  <app-data-column key="actionType" header="Action Type" [sortable]="false">
                    <ng-template #cell let-row>
                      <span class="action-type-label">{{ formatActionType(row.actionType) }}</span>
                    </ng-template>
                  </app-data-column>
                  <app-data-column key="level" header="Safety Level" [sortable]="false">
                    <ng-template #cell let-row>
                      <app-toggle-switch
                        [checked]="row.level === 'auto'"
                        [label]="row.level === 'auto' ? 'Auto-execute' : 'Require Approval'"
                        (checkedChange)="toggleActionSafety(row.actionType, $event ? 'auto' : 'approval')" />
                    </ng-template>
                  </app-data-column>
                </app-data-table>

                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveActionSafety()" [disabled]="actionSafetySaving()">
                    @if (actionSafetySaving()) { Saving... } @else { Save }
                  </app-bronco-button>
                </div>
              }
            </app-card>
          </div>
        </app-tab>

        <!-- Analysis Strategy tab -->
        <app-tab label="Analysis Strategy">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">Analysis Strategy</h2>
              <p class="hint">
                Configure how the AI investigates tickets during agentic analysis.
                <strong>Full Context</strong> sends the entire conversation history on each iteration (higher quality, higher cost).
                <strong>Orchestrated</strong> uses Opus as a strategist to assign parallel tasks to smaller models with a growing knowledge document (lower cost).
              </p>

              @if (analysisStrategyLoading()) {
                <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
              } @else {
                <div class="form-grid">
                  <app-form-field label="Strategy">
                    <app-select
                      [value]="analysisStrategy()"
                      [options]="strategyOptions"
                      [placeholder]="''"
                      (valueChange)="analysisStrategy.set($event)" />
                  </app-form-field>

                  @if (analysisStrategy() === 'orchestrated') {
                    <app-form-field label="Max Parallel Tasks" hint="Number of sub-tasks to run concurrently (1-10)">
                      <input class="text-input" type="number" [value]="analysisMaxParallel()" (input)="setAnalysisMaxParallel(+$any($event.target).value)" min="1" max="10">
                    </app-form-field>
                  }

                  <app-form-field label="Default Max Output Tokens" hint="Global fallback for AI response length. Leave blank for provider default.">
                    <input class="text-input" type="number" [value]="analysisDefaultMaxTokens()" (input)="analysisDefaultMaxTokens.set($any($event.target).value)" min="1024" max="32768" placeholder="e.g. 8192">
                  </app-form-field>

                  <div class="priority-hint">
                    <strong>Max tokens priority order:</strong>
                    <ol>
                      <li>Per-call override (code-level)</li>
                      <li>Prompt config (AI Prompts page)</li>
                      <li>Per-task/client override (AI Prompts &rarr; AI Tasks)</li>
                      <li>This global default</li>
                      <li>Provider default (e.g. Claude 4096)</li>
                    </ol>
                  </div>
                </div>

                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveAnalysisStrategy()" [disabled]="analysisStrategySaving()">
                    @if (analysisStrategySaving()) { Saving... } @else { Save }
                  </app-bronco-button>
                </div>
              }
            </app-card>
          </div>
        </app-tab>

        <!-- Self Analysis tab -->
        <app-tab label="Self Analysis">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">Self Analysis</h2>
              <p class="hint">
                Configure triggers for Bronco to analyze its own operations and suggest improvements.
                Results appear on the System Analysis page.
              </p>

              @if (selfAnalysisLoading()) {
                <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
              } @else {
                <div class="self-analysis-toggles">
                  <div class="analysis-toggle-row">
                    <app-toggle-switch
                      label="Post-analysis trigger"
                      [checked]="selfAnalysisPostAnalysis()"
                      (checkedChange)="updateSelfAnalysis({ postAnalysisTrigger: $event })" />
                    <p class="alert-desc">After each ticket analysis pipeline completes, review the run for token usage, model selection, and route efficiency.</p>
                  </div>

                  <div class="analysis-toggle-row">
                    <app-toggle-switch
                      label="Ticket close trigger"
                      [checked]="selfAnalysisTicketClose()"
                      (checkedChange)="updateSelfAnalysis({ ticketCloseTrigger: $event })" />
                    <p class="alert-desc">When a ticket is closed, analyze its lifecycle for process improvements and knowledge gaps.</p>
                  </div>

                  <div class="analysis-toggle-row">
                    <app-toggle-switch
                      label="Scheduled analysis"
                      [checked]="selfAnalysisScheduled()"
                      (checkedChange)="updateSelfAnalysis({ scheduledEnabled: $event })" />
                    <p class="alert-desc">Run a periodic health analysis of the entire platform (ticket patterns, AI usage, error logs).</p>
                  </div>
                </div>

                @if (selfAnalysisScheduled()) {
                  <div class="form-grid" style="margin-top: 16px;">
                    <app-form-field label="Cron Expression" hint="Standard cron (e.g., &quot;0 9 * * 1&quot; = Monday 9am UTC)">
                      <input class="text-input" [value]="selfAnalysisCron()" (blur)="updateSelfAnalysis({ scheduledCron: $any($event.target).value })">
                    </app-form-field>

                    <app-form-field label="Repository URL" hint="Git repo URL for code-aware analysis via mcp-repo">
                      <input class="text-input" [value]="selfAnalysisRepoUrl()" (blur)="updateSelfAnalysis({ repoUrl: $any($event.target).value })">
                    </app-form-field>
                  </div>
                }
              }
            </app-card>
          </div>
        </app-tab>
      </app-tab-group>
    </div>

    @if (showServiceDialog()) {
      <app-dialog [open]="true" [title]="editingService() ? 'Edit External Service' : 'Add External Service'" maxWidth="500px" (openChange)="showServiceDialog.set(false)">
        <app-external-service-dialog-content
          [service]="editingService() ?? undefined"
          (saved)="onServiceSaved()"
          (cancelled)="showServiceDialog.set(false)" />
      </app-dialog>
    }

    @if (showStatusDialog()) {
      <app-dialog [open]="true" [title]="editingStatus() ? 'Edit Status: ' + editingStatus()!.value : 'Create Status'" maxWidth="500px" (openChange)="showStatusDialog.set(false)">
        <app-status-config-dialog-content
          [config]="editingStatus() ?? undefined"
          (saved)="onStatusSaved()"
          (cancelled)="showStatusDialog.set(false)" />
      </app-dialog>
    }

    @if (showCategoryDialog()) {
      <app-dialog [open]="true" [title]="editingCategory() ? 'Edit Category: ' + editingCategory()!.value : 'Create Category'" maxWidth="500px" (openChange)="showCategoryDialog.set(false)">
        <app-category-config-dialog-content
          [config]="editingCategory() ?? undefined"
          (saved)="onCategorySaved()"
          (cancelled)="showCategoryDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-title {
      margin: 0 0 24px;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .tab-content { padding-top: 8px; }

    .section-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    .section-title {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .hint {
      color: var(--text-tertiary);
      margin-bottom: 16px;
      font-size: 14px;
    }

    .priority-hint {
      margin-top: 8px;
      padding: 10px 14px;
      background: var(--bg-muted);
      border-radius: var(--radius-md);
      font-size: 12px;
      color: var(--text-tertiary);
      line-height: 1.6;
    }
    .priority-hint strong { color: var(--text-secondary); }
    .priority-hint ol {
      margin: 4px 0 0;
      padding-left: 20px;
    }
    .form-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 600px;
    }

    .input-with-toggle {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .input-with-toggle .text-input { flex: 1; }
    .toggle-vis {
      background: none;
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 6px 12px;
      font-family: var(--font-primary);
      font-size: 12px;
      color: var(--text-tertiary);
      cursor: pointer;
      white-space: nowrap;
    }
    .toggle-vis:hover { color: var(--text-primary); }

    .text-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .text-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.15);
    }
    .text-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .card-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
    }

    app-card { display: block; margin-bottom: 16px; }

    .loading-wrapper {
      display: flex;
      justify-content: center;
      padding: 32px;
    }
    .loading-text { color: var(--text-tertiary); font-size: 13px; }

    .empty-state {
      text-align: center;
      padding: 32px 16px;
      color: var(--text-tertiary);
    }
    .empty-state p { margin: 8px 0; }

    .endpoint-text { font-family: monospace; font-size: 13px; color: var(--text-tertiary); }
    .check-type-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--color-info-subtle);
      color: var(--color-info);
      font-family: monospace;
    }

    .color-swatch {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: 1px solid var(--border-light);
    }
    .desc-text { font-size: 13px; color: var(--text-tertiary); }
    code {
      font-size: 12px;
      padding: 2px 6px;
      background: var(--bg-muted);
      border-radius: 3px;
      font-family: monospace;
    }

    .class-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 10px;
      border-radius: var(--radius-pill);
      text-transform: uppercase;
    }
    .class-open { background: var(--color-info-subtle); color: var(--color-info); }
    .class-closed { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }

    .status-yes { color: var(--color-success); font-size: 13px; font-weight: 500; }
    .status-no { color: var(--text-tertiary); font-size: 13px; }

    .delete-action { color: var(--color-error); }

    .action-type-label {
      font-family: monospace;
      font-size: 13px;
      font-weight: 500;
    }

    .self-analysis-toggles {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .analysis-toggle-row {
      display: flex;
      flex-direction: column;
      margin-bottom: 12px;
    }
    .alert-desc {
      font-size: 12px;
      color: var(--text-tertiary);
      margin: 4px 0 0;
      padding-left: 44px;
    }

    .strategyOptions { max-width: 400px; }
  `],
})
export class SettingsComponent implements OnInit {
  private toast = inject(ToastService);
  private extSvc = inject(ExternalServiceService);
  private settingsSvc = inject(SettingsService);
  private userSvc = inject(UserService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  // General tab
  apiKey = sessionStorage.getItem('rc_api_key') ?? '';
  showKey = signal(false);
  adminUsers = signal<ControlPanelUser[]>([]);
  usersLoading = signal(false);
  superAdminUserId: string | null = null;
  superAdminLoading = signal(true);
  superAdminSaving = signal(false);
  superAdminOptions = signal<Array<{ value: string; label: string }>>([]);

  // External Services tab
  services = signal<ExternalService[]>([]);
  showServiceDialog = signal(false);
  editingService = signal<ExternalService | null>(null);

  // Statuses tab
  statuses = signal<TicketStatusConfig[]>([]);
  statusesLoading = signal(true);
  statusesError = signal(false);
  showStatusDialog = signal(false);
  editingStatus = signal<TicketStatusConfig | null>(null);

  // Categories tab
  categories = signal<TicketCategoryConfig[]>([]);
  categoriesLoading = signal(true);
  categoriesError = signal(false);
  showCategoryDialog = signal(false);
  editingCategory = signal<TicketCategoryConfig | null>(null);

  // Action Safety tab
  actionSafetyConfig = signal<Record<string, 'auto' | 'approval'>>({});
  actionSafetyLoading = signal(true);
  actionSafetySaving = signal(false);
  actionSafetyRows = signal<Array<{ actionType: string; level: 'auto' | 'approval' }>>([]);

  // Analysis Strategy tab
  analysisStrategy = signal<string>('full_context');
  analysisMaxParallel = signal(3);
  analysisDefaultMaxTokens = signal<string>('');
  analysisStrategyLoading = signal(true);
  analysisStrategySaving = signal(false);
  strategyOptions = [
    { value: 'full_context', label: 'Full Context (brute force)' },
    { value: 'orchestrated', label: 'Orchestrated (parallel tasks)' },
  ];

  // Self Analysis tab
  selfAnalysisLoading = signal(true);
  selfAnalysisPostAnalysis = signal(false);
  selfAnalysisTicketClose = signal(true);
  selfAnalysisScheduled = signal(false);
  selfAnalysisCron = signal('0 9 * * 1');
  selfAnalysisRepoUrl = signal('https://github.com/siir/bronco');

  selectedTab = signal(0);

  trackStatus = (s: TicketStatusConfig) => s.value;
  trackCategory = (c: TicketCategoryConfig) => c.value;
  trackService = (svc: ExternalService) => svc.id;
  trackActionSafety = (row: { actionType: string }) => row.actionType;

  ngOnInit(): void {
    const tabSlug = this.route.snapshot.queryParamMap.get('tab');
    if (tabSlug) {
      const idx = TAB_LABELS.findIndex(l => this.toSlug(l) === tabSlug);
      if (idx >= 0) this.selectedTab.set(idx);
    }
    this.loadUsers();
    this.loadSuperAdmin();
    this.loadServices();
    this.loadStatuses();
    this.loadCategories();
    this.loadActionSafety();
    this.loadAnalysisStrategy();
    this.loadSelfAnalysis();
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

  // ─── General tab ───

  saveKey(): void {
    sessionStorage.setItem('rc_api_key', this.apiKey);
    this.toast.success('API key saved');
  }

  clearKey(): void {
    this.apiKey = '';
    sessionStorage.removeItem('rc_api_key');
    this.toast.success('API key cleared');
  }

  loadUsers(): void {
    this.usersLoading.set(true);
    this.userSvc.getUsers().subscribe({
      next: (users) => {
        const filtered = users.filter(u => u.isActive && (u.role === 'ADMIN' || u.role === 'OPERATOR'));
        this.adminUsers.set(filtered);
        this.superAdminOptions.set(filtered.map(u => ({
          value: u.id,
          label: `${u.name} (${u.email}) — ${u.role}`,
        })));
        this.usersLoading.set(false);
      },
      error: (err) => {
        this.usersLoading.set(false);
        if (err?.status !== 403) {
          this.toast.error('Failed to load users');
        }
      },
    });
  }

  loadSuperAdmin(): void {
    this.superAdminLoading.set(true);
    this.settingsSvc.getSuperAdminUserId().subscribe({
      next: (result) => {
        this.superAdminUserId = result.userId;
        this.superAdminLoading.set(false);
      },
      error: () => {
        this.superAdminLoading.set(false);
        this.toast.error('Failed to load super admin setting');
      },
    });
  }

  saveSuperAdmin(): void {
    this.superAdminSaving.set(true);
    this.settingsSvc.setSuperAdminUserId(this.superAdminUserId).subscribe({
      next: (result) => {
        this.superAdminUserId = result.userId;
        this.superAdminSaving.set(false);
        this.toast.success('Super admin saved');
      },
      error: () => {
        this.superAdminSaving.set(false);
        this.toast.error('Failed to save super admin');
      },
    });
  }

  loadServices(): void {
    this.extSvc.getAll().subscribe({
      next: (list) => this.services.set(list),
      error: () => this.toast.error('Failed to load external services'),
    });
  }

  addService(): void {
    this.editingService.set(null);
    this.showServiceDialog.set(true);
  }

  editService(svc: ExternalService): void {
    this.editingService.set(svc);
    this.showServiceDialog.set(true);
  }

  onServiceSaved(): void {
    this.showServiceDialog.set(false);
    this.loadServices();
  }

  toggleMonitored(svc: ExternalService): void {
    this.extSvc.update(svc.id, { isMonitored: !svc.isMonitored }).subscribe({
      next: () => {
        this.toast.success(`${svc.name} monitoring ${svc.isMonitored ? 'disabled' : 'enabled'}`);
        this.loadServices();
      },
      error: () => this.toast.error('Failed to update'),
    });
  }

  deleteService(svc: ExternalService): void {
    if (!confirm(`Delete "${svc.name}"? This cannot be undone.`)) return;
    this.extSvc.delete(svc.id).subscribe({
      next: () => {
        this.toast.success(`${svc.name} deleted`);
        this.loadServices();
      },
      error: () => this.toast.error('Failed to delete'),
    });
  }

  // ─── Statuses tab ───

  loadStatuses(): void {
    this.statusesLoading.set(true);
    this.statusesError.set(false);
    this.settingsSvc.getStatuses().subscribe({
      next: (list) => {
        this.statuses.set(list);
        this.statusesLoading.set(false);
      },
      error: () => {
        this.statusesLoading.set(false);
        this.statusesError.set(true);
        this.toast.error('Failed to load status configs');
      },
    });
  }

  createStatus(): void {
    this.editingStatus.set(null);
    this.showStatusDialog.set(true);
  }

  editStatus(config: TicketStatusConfig): void {
    this.editingStatus.set(config);
    this.showStatusDialog.set(true);
  }

  onStatusSaved(): void {
    this.showStatusDialog.set(false);
    this.loadStatuses();
  }

  // ─── Categories tab ───

  loadCategories(): void {
    this.categoriesLoading.set(true);
    this.categoriesError.set(false);
    this.settingsSvc.getCategories().subscribe({
      next: (list) => {
        this.categories.set(list);
        this.categoriesLoading.set(false);
      },
      error: () => {
        this.categoriesLoading.set(false);
        this.categoriesError.set(true);
        this.toast.error('Failed to load category configs');
      },
    });
  }

  createCategory(): void {
    this.editingCategory.set(null);
    this.showCategoryDialog.set(true);
  }

  editCategory(config: TicketCategoryConfig): void {
    this.editingCategory.set(config);
    this.showCategoryDialog.set(true);
  }

  onCategorySaved(): void {
    this.showCategoryDialog.set(false);
    this.loadCategories();
  }

  truncate(value: string, max: number): string {
    return value.length > max ? value.slice(0, max - 3) + '...' : value;
  }

  // ─── Action Safety ───

  loadActionSafety(): void {
    this.actionSafetyLoading.set(true);
    this.settingsSvc.getActionSafety().subscribe({
      next: (config) => {
        this.actionSafetyConfig.set(config.actions);
        this.actionSafetyRows.set(
          Object.entries(config.actions).map(([actionType, level]) => ({ actionType, level }))
        );
        this.actionSafetyLoading.set(false);
      },
      error: () => {
        this.actionSafetyLoading.set(false);
        this.toast.error('Failed to load action safety config');
      },
    });
  }

  toggleActionSafety(actionType: string, level: 'auto' | 'approval'): void {
    const current = { ...this.actionSafetyConfig() };
    current[actionType] = level;
    this.actionSafetyConfig.set(current);
    this.actionSafetyRows.set(
      Object.entries(current).map(([at, l]) => ({ actionType: at, level: l }))
    );
  }

  saveActionSafety(): void {
    this.actionSafetySaving.set(true);
    this.settingsSvc.saveActionSafety({ actions: this.actionSafetyConfig() }).subscribe({
      next: (saved) => {
        this.actionSafetyConfig.set(saved.actions);
        this.actionSafetyRows.set(
          Object.entries(saved.actions).map(([actionType, level]) => ({ actionType, level }))
        );
        this.actionSafetySaving.set(false);
        this.toast.success('Action safety config saved');
      },
      error: () => {
        this.actionSafetySaving.set(false);
        this.toast.error('Failed to save action safety config');
      },
    });
  }

  formatActionType(type: string): string {
    const labels: Record<string, string> = {
      add_comment: 'Add Comment',
      change_status: 'Change Status',
      change_priority: 'Change Priority',
      change_category: 'Change Category',
      assign_operator: 'Assign Operator',
      send_email: 'Send Email',
      create_issue_job: 'Create Issue Job',
      escalate: 'Escalate',
    };
    return labels[type] ?? type;
  }

  // ─── Analysis Strategy ───

  loadAnalysisStrategy(): void {
    this.analysisStrategyLoading.set(true);
    this.settingsSvc.getAnalysisStrategy().subscribe({
      next: (config) => {
        this.analysisStrategy.set(config.strategy);
        this.analysisMaxParallel.set(config.maxParallelTasks);
        this.analysisDefaultMaxTokens.set(config.defaultMaxTokens != null ? String(config.defaultMaxTokens) : '');
        this.analysisStrategyLoading.set(false);
      },
      error: () => {
        this.analysisStrategyLoading.set(false);
        this.toast.error('Failed to load analysis strategy config');
      },
    });
  }

  setAnalysisMaxParallel(value: number): void {
    if (Number.isFinite(value)) {
      this.analysisMaxParallel.set(value);
    }
  }

  saveAnalysisStrategy(): void {
    this.analysisStrategySaving.set(true);
    const rawMaxTokens = this.analysisDefaultMaxTokens().trim();
    const parsedMaxTokens = rawMaxTokens ? Number(rawMaxTokens) : null;
    const config = {
      strategy: this.analysisStrategy() as 'full_context' | 'orchestrated',
      maxParallelTasks: Math.min(10, Math.max(1, this.analysisMaxParallel())),
      defaultMaxTokens: parsedMaxTokens && Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? Math.floor(parsedMaxTokens) : null,
    };
    this.settingsSvc.saveAnalysisStrategy(config).subscribe({
      next: (saved) => {
        this.analysisStrategy.set(saved.strategy);
        this.analysisMaxParallel.set(saved.maxParallelTasks);
        this.analysisDefaultMaxTokens.set(saved.defaultMaxTokens != null ? String(saved.defaultMaxTokens) : '');
        this.analysisStrategySaving.set(false);
        this.toast.success('Analysis strategy saved');
      },
      error: () => {
        this.analysisStrategySaving.set(false);
        this.toast.error('Failed to save analysis strategy');
      },
    });
  }

  // ─── Self Analysis ───

  loadSelfAnalysis(): void {
    this.selfAnalysisLoading.set(true);
    this.settingsSvc.getSelfAnalysis().subscribe({
      next: (config) => {
        this.selfAnalysisPostAnalysis.set(config.postAnalysisTrigger);
        this.selfAnalysisTicketClose.set(config.ticketCloseTrigger);
        this.selfAnalysisScheduled.set(config.scheduledEnabled);
        this.selfAnalysisCron.set(config.scheduledCron);
        this.selfAnalysisRepoUrl.set(config.repoUrl);
        this.selfAnalysisLoading.set(false);
      },
      error: () => {
        this.selfAnalysisLoading.set(false);
        this.toast.error('Failed to load self-analysis config');
      },
    });
  }

  updateSelfAnalysis(partial: Partial<SelfAnalysisConfig>): void {
    if (partial.postAnalysisTrigger !== undefined) this.selfAnalysisPostAnalysis.set(partial.postAnalysisTrigger);
    if (partial.ticketCloseTrigger !== undefined) this.selfAnalysisTicketClose.set(partial.ticketCloseTrigger);
    if (partial.scheduledEnabled !== undefined) this.selfAnalysisScheduled.set(partial.scheduledEnabled);
    if (partial.scheduledCron !== undefined) this.selfAnalysisCron.set(partial.scheduledCron);
    if (partial.repoUrl !== undefined) this.selfAnalysisRepoUrl.set(partial.repoUrl);

    this.settingsSvc.saveSelfAnalysis(partial).subscribe({
      next: (saved) => {
        this.selfAnalysisPostAnalysis.set(saved.postAnalysisTrigger);
        this.selfAnalysisTicketClose.set(saved.ticketCloseTrigger);
        this.selfAnalysisScheduled.set(saved.scheduledEnabled);
        this.selfAnalysisCron.set(saved.scheduledCron);
        this.selfAnalysisRepoUrl.set(saved.repoUrl);
        this.toast.success('Self-analysis config saved');
      },
      error: () => {
        this.toast.error('Failed to save self-analysis config');
        this.loadSelfAnalysis();
      },
    });
  }
}
