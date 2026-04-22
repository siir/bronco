import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  ExternalServiceService,
  ExternalService,
} from '../../core/services/external-service.service.js';
import { UserService, ControlPanelUser } from '../../core/services/user.service.js';
import {
  SettingsService,
  TicketStatusConfig,
  TicketCategoryConfig,
  SelfAnalysisConfig,
  SmtpSystemConfig,
  DevOpsSystemConfig,
  GithubSystemConfig,
  ImapSystemConfig,
  SlackSystemConfig,
  PromptRetentionConfig,
  ToolRequestRateLimitConfig,
  ToolRequestsDefaultRepoConfig,
} from '../../core/services/settings.service.js';
import { ExternalServiceDialogComponent } from './external-service-dialog.component.js';
import { StatusConfigDialogComponent } from './status-config-dialog.component.js';
import { CategoryConfigDialogComponent } from './category-config-dialog.component.js';
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
  IconComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service.js';

const TAB_LABELS = ['General', 'Ticket Statuses', 'Ticket Categories', 'External Services', 'Action Safety', 'Analysis Strategy', 'Self Analysis', 'SMTP', 'Azure DevOps', 'GitHub', 'IMAP', 'Slack', 'Prompt Retention', 'Tool Requests'] as const;

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
    IconComponent,
    ExternalServiceDialogComponent,
    StatusConfigDialogComponent,
    CategoryConfigDialogComponent,
  ],
  template: `
    <div class="page-wrapper">
      <h1 class="page-title">System Settings</h1>

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
                      <app-icon name="edit" size="sm" />
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
                      <app-icon name="edit" size="sm" />
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

            <app-card>
              <h2 class="section-title">Strategy Version</h2>
              <p class="hint">
                v2 is the default. v1 is retained verbatim from before the templated knowledge doc
                was introduced, for fallback and comparison when v2 regresses. Do not mix v2 features
                into v1 \u2014 they evolve independently.
              </p>
              @if (analysisStrategyVersionLoading()) {
                <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
              } @else {
                <div class="form-grid">
                  <app-form-field label="Strategy Version" hint="v2 is default. v1 is for comparison/fallback only.">
                    <app-select
                      [value]="analysisStrategyVersion()"
                      [options]="strategyVersionOptions"
                      (valueChange)="analysisStrategyVersion.set($event)" />
                  </app-form-field>
                </div>

                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveAnalysisStrategyVersion()" [disabled]="analysisStrategyVersionSaving()">
                    @if (analysisStrategyVersionSaving()) { Saving... } @else { Save }
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

        <!-- SMTP Tab -->
        <app-tab label="SMTP">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">SMTP Configuration</h2>
              <p class="hint">Configure the SMTP server used for sending emails. Password is encrypted at rest.</p>
              <div class="form-grid">
                <app-form-field label="Host"><input class="text-input" [(ngModel)]="smtp.host" placeholder="smtp.example.com"></app-form-field>
                <app-form-field label="Port"><input class="text-input" type="number" [(ngModel)]="smtp.port" placeholder="587"></app-form-field>
                <app-form-field label="User"><input class="text-input" [(ngModel)]="smtp.user" placeholder="user&#64;example.com"></app-form-field>
                <app-form-field label="Password"><input class="text-input" type="password" [(ngModel)]="smtp.password"></app-form-field>
                <app-form-field label="From Address"><input class="text-input" [(ngModel)]="smtp.from" placeholder="noreply&#64;example.com"></app-form-field>
                <app-form-field label="From Name"><input class="text-input" [(ngModel)]="smtp.fromName" placeholder="Bronco"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveSmtp()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="testSmtp()" [disabled]="sysConfigTesting()">{{ sysConfigTesting() ? 'Testing...' : 'Test Connection' }}</app-bronco-button>
              </div>
            </app-card>
          </div>
        </app-tab>

        <!-- Azure DevOps Tab -->
        <app-tab label="Azure DevOps">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">Azure DevOps Configuration</h2>
              <p class="hint">Configure the Azure DevOps integration for work item sync. PAT is encrypted at rest.</p>
              <div class="form-grid">
                <app-form-field label="Organization URL"><input class="text-input" [(ngModel)]="devops.orgUrl" placeholder="https://dev.azure.com/myorg"></app-form-field>
                <app-form-field label="Project"><input class="text-input" [(ngModel)]="devops.project" placeholder="MyProject"></app-form-field>
                <app-form-field label="Personal Access Token"><input class="text-input" type="password" [(ngModel)]="devops.pat"></app-form-field>
                <app-form-field label="Assigned User"><input class="text-input" [(ngModel)]="devops.assignedUser" placeholder="user&#64;example.com"></app-form-field>
                <app-form-field label="Client Short Code"><input class="text-input" [(ngModel)]="devops.clientShortCode"></app-form-field>
                <app-form-field label="Poll Interval (seconds)"><input class="text-input" type="number" [(ngModel)]="devops.pollIntervalSeconds" placeholder="120"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveDevOps()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="testDevOps()" [disabled]="sysConfigTesting()">{{ sysConfigTesting() ? 'Testing...' : 'Test Connection' }}</app-bronco-button>
              </div>
            </app-card>
          </div>
        </app-tab>

        <!-- GitHub Tab -->
        <app-tab label="GitHub">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">GitHub Configuration</h2>
              <p class="hint">Configure the GitHub token used for repository access and release notes. Token is encrypted at rest.</p>
              <div class="form-grid">
                <app-form-field label="Token"><input class="text-input" type="password" [(ngModel)]="github.token"></app-form-field>
                <app-form-field label="Repository"><input class="text-input" [(ngModel)]="github.repo" placeholder="owner/repo"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveGithub()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="testGithub()" [disabled]="sysConfigTesting()">{{ sysConfigTesting() ? 'Testing...' : 'Test Connection' }}</app-bronco-button>
              </div>
            </app-card>
          </div>
        </app-tab>

        <!-- IMAP Tab -->
        <app-tab label="IMAP">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">IMAP Configuration</h2>
              <p class="hint">Configure the IMAP server used for polling inbound emails. Password is encrypted at rest.</p>
              <div class="form-grid">
                <app-form-field label="Host"><input class="text-input" [(ngModel)]="imapConfig.host" placeholder="imap.example.com"></app-form-field>
                <app-form-field label="Port"><input class="text-input" type="number" [(ngModel)]="imapConfig.port" placeholder="993"></app-form-field>
                <app-form-field label="User"><input class="text-input" [(ngModel)]="imapConfig.user" placeholder="user&#64;example.com"></app-form-field>
                <app-form-field label="Password"><input class="text-input" type="password" [(ngModel)]="imapConfig.password"></app-form-field>
                <app-form-field label="Poll Interval (seconds)"><input class="text-input" type="number" [(ngModel)]="imapConfig.pollIntervalSeconds" placeholder="60"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveImap()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="testImap()" [disabled]="sysConfigTesting()">{{ sysConfigTesting() ? 'Testing...' : 'Test Connection' }}</app-bronco-button>
              </div>
            </app-card>
          </div>
        </app-tab>

        <!-- Slack Tab -->
        <app-tab label="Slack">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">Slack Configuration</h2>
              <p class="hint">Configure Slack integration for operator notifications via Socket Mode. Tokens are encrypted at rest.</p>
              <div class="form-grid">
                <div class="toggle-row">
                  <app-toggle-switch label="Enabled" [checked]="slackConfig.enabled" (checkedChange)="slackConfig.enabled = $event" />
                </div>
                <app-form-field label="Bot Token (xoxb-...)"><input class="text-input" type="password" [(ngModel)]="slackConfig.botToken" placeholder="xoxb-..."></app-form-field>
                <app-form-field label="App-Level Token (xapp-...)"><input class="text-input" type="password" [(ngModel)]="slackConfig.appToken" placeholder="xapp-..."></app-form-field>
                <app-form-field label="Default Channel ID"><input class="text-input" [(ngModel)]="slackConfig.defaultChannelId" placeholder="C0123456789"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveSlackConfig()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="testSlackConfig()" [disabled]="sysConfigTesting()">{{ sysConfigTesting() ? 'Testing...' : 'Test Connection' }}</app-bronco-button>
              </div>
            </app-card>
          </div>
        </app-tab>

        <!-- Prompt Retention Tab -->
        <app-tab label="Prompt Retention">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">Prompt Retention Policy</h2>
              <p class="hint">Configure how long full AI prompt/response archives are retained before being summarized and deleted.</p>
              <div class="form-grid">
                <app-form-field label="Full prompt retention (days)"><input class="text-input" type="number" [(ngModel)]="promptRetention.fullRetentionDays" min="1" placeholder="30"></app-form-field>
                <app-form-field label="Summary retention (days after summarization)"><input class="text-input" type="number" [(ngModel)]="promptRetention.summaryRetentionDays" min="1" placeholder="90"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="savePromptRetention()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
              </div>
            </app-card>
          </div>
        </app-tab>

        <!-- Tool Requests Tab -->
        <app-tab label="Tool Requests">
          <div class="tab-content">
            <app-card>
              <h2 class="section-title">Tool Request Rate Limit</h2>
              <p class="hint">Caps how often the analyzer can call <code>request_tool</code> within a single analysis run. Prevents runaway requests when an agent loops on missing capabilities.</p>
              <div class="form-grid">
                <app-form-field label="Maximum request_tool calls per analysis run"><input class="text-input" type="number" [(ngModel)]="toolRequestRateLimit.limit" min="1" max="100" placeholder="5"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveToolRequestRateLimit()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
              </div>
            </app-card>

            <app-card>
              <h2 class="section-title">GitHub Default Repo</h2>
              <p class="hint">Target repository when an operator clicks "Create GitHub Issue" on an approved tool request. Uses the token from the GitHub tab.</p>
              <div class="form-grid">
                <app-form-field label="Owner"><input class="text-input" type="text" [(ngModel)]="toolRequestsDefaultRepo.owner" placeholder="e.g. siir"></app-form-field>
                <app-form-field label="Repo name"><input class="text-input" type="text" [(ngModel)]="toolRequestsDefaultRepo.name" placeholder="e.g. bronco"></app-form-field>
              </div>
              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveToolRequestsDefaultRepo()" [disabled]="sysConfigSaving()">Save</app-bronco-button>
              </div>
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
  superAdminOptions = signal<Array<{ value: string; label: string }>>([
    { value: '', label: '-- None --' },
  ]);

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
  analysisStrategyVersion = signal<string>('v2');
  analysisStrategyVersionLoading = signal(true);
  analysisStrategyVersionSaving = signal(false);
  strategyVersionOptions = [
    { value: 'v2', label: 'v2 (default \u2014 truncation + kd_* knowledge doc + no auto-summary)' },
    { value: 'v1', label: 'v1 (legacy \u2014 full context per call + raw-append knowledge doc)' },
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
    this.loadAnalysisStrategyVersion();
    this.loadSelfAnalysis();
    this.loadSystemConfigs();
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
        const filtered = users.filter(u => u.isActive && (u.role === 'ADMIN' || u.role === 'STANDARD'));
        this.adminUsers.set(filtered);
        this.superAdminOptions.set([
          { value: '', label: '-- None --' },
          ...filtered.map(u => ({
            value: u.id,
            label: `${u.name} (${u.email}) — ${u.role}`,
          })),
        ]);
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

  loadAnalysisStrategyVersion(): void {
    this.analysisStrategyVersionLoading.set(true);
    this.settingsSvc.getAnalysisStrategyVersion().subscribe({
      next: (config) => {
        this.analysisStrategyVersion.set(config.version);
        this.analysisStrategyVersionLoading.set(false);
      },
      error: () => {
        this.analysisStrategyVersionLoading.set(false);
        this.toast.error('Failed to load analysis strategy version');
      },
    });
  }

  saveAnalysisStrategyVersion(): void {
    this.analysisStrategyVersionSaving.set(true);
    const config = { version: this.analysisStrategyVersion() as 'v1' | 'v2' };
    this.settingsSvc.saveAnalysisStrategyVersion(config).subscribe({
      next: (saved) => {
        this.analysisStrategyVersion.set(saved.version);
        this.analysisStrategyVersionSaving.set(false);
        this.toast.success('Analysis strategy version saved');
      },
      error: () => {
        this.analysisStrategyVersionSaving.set(false);
        this.toast.error('Failed to save analysis strategy version');
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

  // ─── System Config (SMTP, DevOps, GitHub, IMAP, Slack, Prompt Retention) ───

  sysConfigSaving = signal(false);
  sysConfigTesting = signal(false);

  smtp: SmtpSystemConfig = { host: '', port: 587, user: '', password: '', from: '', fromName: '' };
  devops: DevOpsSystemConfig = { orgUrl: '', project: '', pat: '', assignedUser: '', clientShortCode: '', pollIntervalSeconds: 120 };
  github: GithubSystemConfig = { token: '', repo: '' };
  imapConfig: ImapSystemConfig = { host: '', port: 993, user: '', password: '', pollIntervalSeconds: 60 };
  slackConfig: SlackSystemConfig = { botToken: '', appToken: '', defaultChannelId: '', enabled: false };
  promptRetention: PromptRetentionConfig = { fullRetentionDays: 30, summaryRetentionDays: 90 };
  toolRequestRateLimit: ToolRequestRateLimitConfig = { limit: 5 };
  toolRequestsDefaultRepo: ToolRequestsDefaultRepoConfig = { owner: '', name: '' };

  private loadSystemConfigs(): void {
    this.settingsSvc.getSmtpConfig().subscribe({ next: (c) => { if (c) this.smtp = { ...this.smtp, ...c }; } });
    this.settingsSvc.getDevOpsConfig().subscribe({ next: (c) => { if (c) this.devops = { ...this.devops, ...c }; } });
    this.settingsSvc.getGithubConfig().subscribe({ next: (c) => { if (c) this.github = { ...this.github, ...c }; } });
    this.settingsSvc.getImapConfig().subscribe({ next: (c) => { if (c) this.imapConfig = { ...this.imapConfig, ...c }; } });
    this.settingsSvc.getSlackConfig().subscribe({ next: (c) => { if (c) this.slackConfig = { ...this.slackConfig, ...c }; } });
    this.settingsSvc.getPromptRetention().subscribe({ next: (c) => { if (c) this.promptRetention = { ...this.promptRetention, ...c }; } });
    this.settingsSvc.getToolRequestRateLimit().subscribe({ next: (c) => { if (c) this.toolRequestRateLimit = { ...this.toolRequestRateLimit, ...c }; } });
    this.settingsSvc.getToolRequestsDefaultRepo().subscribe({ next: (c) => { if (c) this.toolRequestsDefaultRepo = { ...this.toolRequestsDefaultRepo, ...c }; } });
  }

  saveSmtp(): void { this.sysConfigSaving.set(true); this.settingsSvc.updateSmtpConfig(this.smtp).subscribe({ next: (c) => { this.smtp = { ...this.smtp, ...c }; this.toast.success('SMTP config saved'); this.sysConfigSaving.set(false); }, error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); } }); }
  testSmtp(): void { this.sysConfigTesting.set(true); this.settingsSvc.testSmtpConfig().subscribe({ next: (r) => { r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed'); this.sysConfigTesting.set(false); }, error: () => { this.toast.error('Test failed'); this.sysConfigTesting.set(false); } }); }

  saveDevOps(): void { this.sysConfigSaving.set(true); this.settingsSvc.updateDevOpsConfig(this.devops).subscribe({ next: (c) => { this.devops = { ...this.devops, ...c }; this.toast.success('DevOps config saved'); this.sysConfigSaving.set(false); }, error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); } }); }
  testDevOps(): void { this.sysConfigTesting.set(true); this.settingsSvc.testDevOpsConfig().subscribe({ next: (r) => { r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed'); this.sysConfigTesting.set(false); }, error: () => { this.toast.error('Test failed'); this.sysConfigTesting.set(false); } }); }

  saveGithub(): void { this.sysConfigSaving.set(true); this.settingsSvc.updateGithubConfig(this.github).subscribe({ next: (c) => { this.github = { ...this.github, ...c }; this.toast.success('GitHub config saved'); this.sysConfigSaving.set(false); }, error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); } }); }
  testGithub(): void { this.sysConfigTesting.set(true); this.settingsSvc.testGithubConfig().subscribe({ next: (r) => { r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed'); this.sysConfigTesting.set(false); }, error: () => { this.toast.error('Test failed'); this.sysConfigTesting.set(false); } }); }

  saveImap(): void { this.sysConfigSaving.set(true); this.settingsSvc.saveImapConfig(this.imapConfig).subscribe({ next: (c) => { this.imapConfig = { ...this.imapConfig, ...c }; this.toast.success('IMAP config saved'); this.sysConfigSaving.set(false); }, error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); } }); }
  testImap(): void { this.sysConfigTesting.set(true); this.settingsSvc.testImapConnection().subscribe({ next: (r) => { r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed'); this.sysConfigTesting.set(false); }, error: () => { this.toast.error('Test failed'); this.sysConfigTesting.set(false); } }); }

  saveSlackConfig(): void { this.sysConfigSaving.set(true); this.settingsSvc.saveSlackConfig(this.slackConfig).subscribe({ next: (c) => { this.slackConfig = { ...this.slackConfig, ...c }; this.toast.success('Slack config saved'); this.sysConfigSaving.set(false); }, error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); } }); }
  testSlackConfig(): void { this.sysConfigTesting.set(true); this.settingsSvc.testSlackConnection().subscribe({ next: (r) => { r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed'); this.sysConfigTesting.set(false); }, error: () => { this.toast.error('Test failed'); this.sysConfigTesting.set(false); } }); }

  savePromptRetention(): void { this.sysConfigSaving.set(true); this.settingsSvc.savePromptRetention(this.promptRetention).subscribe({ next: (c: PromptRetentionConfig) => { this.promptRetention = { ...this.promptRetention, ...c }; this.toast.success('Prompt retention saved'); this.sysConfigSaving.set(false); }, error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); } }); }

  saveToolRequestRateLimit(): void { this.sysConfigSaving.set(true); this.settingsSvc.saveToolRequestRateLimit(this.toolRequestRateLimit).subscribe({ next: (c: ToolRequestRateLimitConfig) => { this.toolRequestRateLimit = { ...this.toolRequestRateLimit, ...c }; this.toast.success('Tool request rate limit saved'); this.sysConfigSaving.set(false); }, error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); } }); }

  saveToolRequestsDefaultRepo(): void {
    const owner = this.toolRequestsDefaultRepo.owner.trim();
    const name = this.toolRequestsDefaultRepo.name.trim();
    if (!owner || !name) { this.toast.error('Both owner and repo name are required'); return; }
    this.sysConfigSaving.set(true);
    this.settingsSvc.saveToolRequestsDefaultRepo({ owner, name }).subscribe({
      next: (c: ToolRequestsDefaultRepoConfig) => { this.toolRequestsDefaultRepo = { ...this.toolRequestsDefaultRepo, ...c }; this.toast.success('Default repo saved'); this.sysConfigSaving.set(false); },
      error: () => { this.toast.error('Failed to save'); this.sysConfigSaving.set(false); },
    });
  }
}
