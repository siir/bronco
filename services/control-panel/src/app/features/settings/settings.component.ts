import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { MatTabsModule } from '@angular/material/tabs';
import {
  ExternalServiceService,
  ExternalService,
} from '../../core/services/external-service.service';
import { UserService, ControlPanelUser } from '../../core/services/user.service';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  SettingsService,
  TicketStatusConfig,
  TicketCategoryConfig,
  OperationalAlertConfig,
} from '../../core/services/settings.service';
import { ExternalServiceDialogComponent } from './external-service-dialog.component';
import { StatusConfigDialogComponent } from './status-config-dialog.component';
import { CategoryConfigDialogComponent } from './category-config-dialog.component';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    MatTableModule,
    MatChipsModule,
    MatTooltipModule,
    MatMenuModule,
    MatDividerModule,
    MatTabsModule,
    MatSlideToggleModule,
    MatSelectModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h1>Settings</h1>

    <mat-tab-group [selectedIndex]="selectedTab()" (selectedTabChange)="onTabChange($event.index)">
      <!-- General tab -->
      <mat-tab label="General">
        <div class="tab-content">
          <mat-card>
            <mat-card-header>
              <mat-card-title>API Configuration</mat-card-title>
            </mat-card-header>
            <mat-card-content>
              <p class="hint">The API key is stored in session storage (cleared when tab closes) and sent with every request.</p>
              <mat-form-field class="full-width">
                <mat-label>API Key</mat-label>
                <input matInput [type]="showKey() ? 'text' : 'password'" [(ngModel)]="apiKey">
                <button mat-icon-button matSuffix (click)="showKey.set(!showKey())">
                  <mat-icon>{{ showKey() ? 'visibility_off' : 'visibility' }}</mat-icon>
                </button>
              </mat-form-field>
            </mat-card-content>
            <mat-card-actions>
              <button mat-raised-button color="primary" (click)="saveKey()">
                <mat-icon>save</mat-icon> Save API Key
              </button>
              <button mat-button color="warn" (click)="clearKey()">Clear</button>
            </mat-card-actions>
          </mat-card>

          <mat-card class="section-card">
            <mat-card-header>
              <mat-card-title>Super Admin</mat-card-title>
            </mat-card-header>
            <mat-card-content>
              <p class="hint">Designate a control panel user as the super admin. This user will have elevated privileges for system-wide operations.</p>
              <mat-form-field class="full-width">
                <mat-label>Super Admin User</mat-label>
                <mat-select [(ngModel)]="superAdminUserId" [disabled]="usersLoading()">
                  <mat-option [value]="null">— None —</mat-option>
                  @for (u of adminUsers(); track u.id) {
                    <mat-option [value]="u.id">{{ u.name }} ({{ u.email }}) — {{ u.role }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            </mat-card-content>
            <mat-card-actions>
              <button mat-raised-button color="primary" (click)="saveSuperAdmin()" [disabled]="superAdminSaving()">
                @if (superAdminSaving()) {
                  <mat-spinner diameter="18" class="inline-spinner"></mat-spinner>
                }
                Save
              </button>
            </mat-card-actions>
          </mat-card>
        </div>
      </mat-tab>

      <!-- Ticket Statuses tab -->
      <mat-tab label="Ticket Statuses">
        <div class="tab-content">
          <mat-card>
            <mat-card-header>
              <mat-card-title>Ticket Statuses</mat-card-title>
              <div class="header-spacer"></div>
              <button mat-raised-button color="primary" (click)="createStatus()">
                <mat-icon>add</mat-icon> Create Status
              </button>
            </mat-card-header>
            <mat-card-content>
              <p class="hint">
                Configure how ticket statuses appear and behave. Each status belongs to either the
                <strong>open</strong> class (active tickets) or the <strong>closed</strong> class (terminal tickets).
              </p>

              @if (statusesLoading()) {
                <div class="empty-state">
                  <mat-icon>hourglass_empty</mat-icon>
                  <p>Loading status configurations...</p>
                </div>
              } @else if (statusesError()) {
                <div class="empty-state">
                  <mat-icon>error_outline</mat-icon>
                  <p>Failed to load status configurations.</p>
                  <button mat-button color="primary" (click)="loadStatuses()">Retry</button>
                </div>
              } @else {
                <table mat-table [dataSource]="statuses()" class="full-table">
                  <ng-container matColumnDef="color">
                    <th mat-header-cell *matHeaderCellDef>Color</th>
                    <td mat-cell *matCellDef="let s">
                      <div class="color-swatch" [style.background]="s.color"></div>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="value">
                    <th mat-header-cell *matHeaderCellDef>Value</th>
                    <td mat-cell *matCellDef="let s">
                      <code>{{ s.value }}</code>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="displayName">
                    <th mat-header-cell *matHeaderCellDef>Display Name</th>
                    <td mat-cell *matCellDef="let s">{{ s.displayName }}</td>
                  </ng-container>

                  <ng-container matColumnDef="description">
                    <th mat-header-cell *matHeaderCellDef>Description</th>
                    <td mat-cell *matCellDef="let s">
                      <span class="desc-text">{{ s.description ?? '—' }}</span>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="statusClass">
                    <th mat-header-cell *matHeaderCellDef>Class</th>
                    <td mat-cell *matCellDef="let s">
                      <span class="class-chip" [class.class-open]="s.statusClass === 'open'" [class.class-closed]="s.statusClass === 'closed'">
                        {{ s.statusClass }}
                      </span>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="sortOrder">
                    <th mat-header-cell *matHeaderCellDef>Order</th>
                    <td mat-cell *matCellDef="let s">{{ s.sortOrder }}</td>
                  </ng-container>

                  <ng-container matColumnDef="active">
                    <th mat-header-cell *matHeaderCellDef>Active</th>
                    <td mat-cell *matCellDef="let s">
                      <mat-icon [class.monitored-yes]="s.isActive" [class.monitored-no]="!s.isActive">
                        {{ s.isActive ? 'check_circle' : 'cancel' }}
                      </mat-icon>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="statusActions">
                    <th mat-header-cell *matHeaderCellDef></th>
                    <td mat-cell *matCellDef="let s">
                      <button mat-icon-button matTooltip="Edit" (click)="editStatus(s)">
                        <mat-icon>edit</mat-icon>
                      </button>
                    </td>
                  </ng-container>

                  <tr mat-header-row *matHeaderRowDef="statusColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: statusColumns;"></tr>
                </table>
              }
            </mat-card-content>
          </mat-card>
        </div>
      </mat-tab>

      <!-- Ticket Categories tab -->
      <mat-tab label="Ticket Categories">
        <div class="tab-content">
          <mat-card>
            <mat-card-header>
              <mat-card-title>Ticket Categories</mat-card-title>
              <div class="header-spacer"></div>
              <button mat-raised-button color="primary" (click)="createCategory()">
                <mat-icon>add</mat-icon> Create Category
              </button>
            </mat-card-header>
            <mat-card-content>
              <p class="hint">
                Configure ticket categories used for classifying and organizing tickets.
                Categories help route tickets to the right workflow.
              </p>

              @if (categoriesLoading()) {
                <div class="empty-state">
                  <mat-icon>hourglass_empty</mat-icon>
                  <p>Loading category configurations...</p>
                </div>
              } @else if (categoriesError()) {
                <div class="empty-state">
                  <mat-icon>error_outline</mat-icon>
                  <p>Failed to load category configurations.</p>
                  <button mat-button color="primary" (click)="loadCategories()">Retry</button>
                </div>
              } @else {
                <table mat-table [dataSource]="categories()" class="full-table">
                  <ng-container matColumnDef="catColor">
                    <th mat-header-cell *matHeaderCellDef>Color</th>
                    <td mat-cell *matCellDef="let c">
                      <div class="color-swatch" [style.background]="c.color"></div>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="catValue">
                    <th mat-header-cell *matHeaderCellDef>Value</th>
                    <td mat-cell *matCellDef="let c">
                      <code>{{ c.value }}</code>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="catDisplayName">
                    <th mat-header-cell *matHeaderCellDef>Display Name</th>
                    <td mat-cell *matCellDef="let c">{{ c.displayName }}</td>
                  </ng-container>

                  <ng-container matColumnDef="catDescription">
                    <th mat-header-cell *matHeaderCellDef>Description</th>
                    <td mat-cell *matCellDef="let c">
                      <span class="desc-text">{{ c.description ?? '—' }}</span>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="catSortOrder">
                    <th mat-header-cell *matHeaderCellDef>Order</th>
                    <td mat-cell *matCellDef="let c">{{ c.sortOrder }}</td>
                  </ng-container>

                  <ng-container matColumnDef="catActive">
                    <th mat-header-cell *matHeaderCellDef>Active</th>
                    <td mat-cell *matCellDef="let c">
                      <mat-icon [class.monitored-yes]="c.isActive" [class.monitored-no]="!c.isActive">
                        {{ c.isActive ? 'check_circle' : 'cancel' }}
                      </mat-icon>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="catActions">
                    <th mat-header-cell *matHeaderCellDef></th>
                    <td mat-cell *matCellDef="let c">
                      <button mat-icon-button matTooltip="Edit" (click)="editCategory(c)">
                        <mat-icon>edit</mat-icon>
                      </button>
                    </td>
                  </ng-container>

                  <tr mat-header-row *matHeaderRowDef="catColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: catColumns;"></tr>
                </table>
              }
            </mat-card-content>
          </mat-card>
        </div>
      </mat-tab>

      <!-- Operational Alerts tab -->
      <mat-tab label="Operational Alerts">
        <div class="tab-content">
          @if (alertsLoading()) {
            <div class="empty-state">
              <mat-icon>hourglass_empty</mat-icon>
              <p>Loading alert configuration...</p>
            </div>
          } @else if (alertsError()) {
            <div class="empty-state">
              <mat-icon>error_outline</mat-icon>
              <p>Failed to load alert configuration.</p>
              <button mat-button color="primary" (click)="loadAlertConfig()">Retry</button>
            </div>
          } @else {
            <mat-card>
              <mat-card-header>
                <mat-card-title>Alert Notifications</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <p class="hint">
                  Get email notifications when background processes fail silently.
                  Requires an active EMAIL notification channel configured under Notification Channels.
                </p>

                <div class="alert-toggle-row">
                  <mat-slide-toggle
                    [checked]="alertConfig().enabled"
                    (change)="setAlertEnabled($event.checked)">
                    Enable operational alerts
                  </mat-slide-toggle>
                </div>

                <mat-form-field class="full-width">
                  <mat-label>Recipient Email</mat-label>
                  <input matInput type="email"
                    [ngModel]="alertConfig().recipientEmail"
                    (ngModelChange)="setAlertRecipientEmail($event)"
                    placeholder="operator@example.com">
                </mat-form-field>

                <mat-form-field class="full-width">
                  <mat-label>Throttle (minutes between repeat alerts)</mat-label>
                  <mat-select
                    [ngModel]="alertConfig().throttleMinutes"
                    (ngModelChange)="setAlertThrottleMinutes($event)">
                    <mat-option [value]="15">15 minutes</mat-option>
                    <mat-option [value]="30">30 minutes</mat-option>
                    <mat-option [value]="60">1 hour</mat-option>
                    <mat-option [value]="120">2 hours</mat-option>
                  </mat-select>
                </mat-form-field>

                <h3>Alert Types</h3>

                <div class="alert-toggles">
                  <div class="alert-toggle-row">
                    <mat-slide-toggle
                      [checked]="alertConfig().alerts.failedJobs"
                      (change)="setAlertType('failedJobs', $event.checked)">
                      Failed BullMQ jobs
                    </mat-slide-toggle>
                    <span class="alert-desc">Alert when background job queues have failed jobs</span>
                  </div>

                  <div class="alert-toggle-row">
                    <mat-slide-toggle
                      [checked]="alertConfig().alerts.probeMisses"
                      (change)="setAlertType('probeMisses', $event.checked)">
                      Missed probe schedules
                    </mat-slide-toggle>
                    <span class="alert-desc">Alert when scheduled probes miss their expected run window</span>
                  </div>

                  <div class="alert-toggle-row">
                    <mat-slide-toggle
                      [checked]="alertConfig().alerts.aiProviderDown"
                      (change)="setAlertType('aiProviderDown', $event.checked)">
                      AI provider outages
                    </mat-slide-toggle>
                    <span class="alert-desc">Alert when Ollama or cloud AI providers are unreachable or failing</span>
                  </div>

                  <div class="alert-toggle-row">
                    <mat-slide-toggle
                      [checked]="alertConfig().alerts.devopsSyncStale"
                      (change)="setAlertType('devopsSyncStale', $event.checked)">
                      DevOps sync staleness
                    </mat-slide-toggle>
                    <span class="alert-desc">Alert when Azure DevOps sync stops (PAT expired, rate limit, etc)</span>
                  </div>

                  <div class="alert-toggle-row">
                    <mat-slide-toggle
                      [checked]="alertConfig().alerts.summarizationStale"
                      (change)="setAlertType('summarizationStale', $event.checked)">
                      Log summarization staleness
                    </mat-slide-toggle>
                    <span class="alert-desc">Alert when log summarization hasn't run in over 2 hours</span>
                  </div>
                </div>
              </mat-card-content>
              <mat-card-actions>
                <button mat-raised-button color="primary" (click)="saveAlertConfig()" [disabled]="alertsSaving()">
                  @if (alertsSaving()) {
                    <mat-spinner diameter="18" class="inline-spinner"></mat-spinner>
                  }
                  Save
                </button>
                <button mat-button (click)="testAlert()" [disabled]="alertsTesting()">
                  @if (alertsTesting()) {
                    <mat-spinner diameter="18" class="inline-spinner"></mat-spinner>
                  }
                  Test Alert
                </button>
              </mat-card-actions>
            </mat-card>
          }
        </div>
      </mat-tab>
      <!-- External Services tab -->
      <mat-tab label="External Services">
        <div class="tab-content">
          <mat-card>
            <mat-card-header>
              <mat-card-title>External Services</mat-card-title>
              <div class="header-spacer"></div>
              <button mat-raised-button color="primary" (click)="addService()">
                <mat-icon>add</mat-icon> Add Service
              </button>
            </mat-card-header>
            <mat-card-content>
              <p class="hint">
                Configure external services to monitor on the System Status page.
                Services like Ollama, reverse proxies, or other health endpoints can be tracked here.
              </p>

              @if (services().length === 0) {
                <div class="empty-state">
                  <mat-icon>cloud_off</mat-icon>
                  <p>No external services configured.</p>
                  <p class="hint">Add services like Ollama or other endpoints to monitor them on the System Status page.</p>
                </div>
              } @else {
                <table mat-table [dataSource]="services()" class="full-table">
                  <ng-container matColumnDef="name">
                    <th mat-header-cell *matHeaderCellDef>Name</th>
                    <td mat-cell *matCellDef="let svc">{{ svc.name }}</td>
                  </ng-container>

                  <ng-container matColumnDef="endpoint">
                    <th mat-header-cell *matHeaderCellDef>Endpoint</th>
                    <td mat-cell *matCellDef="let svc">
                      <span class="endpoint-text" [matTooltip]="svc.endpoint">{{ truncate(svc.endpoint, 40) }}</span>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="checkType">
                    <th mat-header-cell *matHeaderCellDef>Check Type</th>
                    <td mat-cell *matCellDef="let svc">
                      <span class="check-type-chip">{{ svc.checkType }}</span>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="monitored">
                    <th mat-header-cell *matHeaderCellDef>Monitored</th>
                    <td mat-cell *matCellDef="let svc">
                      <mat-icon
                        [class.monitored-yes]="svc.isMonitored"
                        [class.monitored-no]="!svc.isMonitored"
                      >
                        {{ svc.isMonitored ? 'check_circle' : 'cancel' }}
                      </mat-icon>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="svcActions">
                    <th mat-header-cell *matHeaderCellDef></th>
                    <td mat-cell *matCellDef="let svc">
                      <button mat-icon-button [matMenuTriggerFor]="svcMenu" matTooltip="Actions">
                        <mat-icon>more_vert</mat-icon>
                      </button>
                      <mat-menu #svcMenu="matMenu">
                        <button mat-menu-item (click)="editService(svc)">
                          <mat-icon>edit</mat-icon> Edit
                        </button>
                        <button mat-menu-item (click)="toggleMonitored(svc)">
                          <mat-icon>{{ svc.isMonitored ? 'visibility_off' : 'visibility' }}</mat-icon>
                          {{ svc.isMonitored ? 'Disable Monitoring' : 'Enable Monitoring' }}
                        </button>
                        <mat-divider></mat-divider>
                        <button mat-menu-item (click)="deleteService(svc)" class="delete-action">
                          <mat-icon>delete</mat-icon> Delete
                        </button>
                      </mat-menu>
                    </td>
                  </ng-container>

                  <tr mat-header-row *matHeaderRowDef="svcColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: svcColumns;"></tr>
                </table>
              }
            </mat-card-content>
          </mat-card>
        </div>
      </mat-tab>
      <!-- Action Safety tab -->
      <mat-tab label="Action Safety">
        <div class="tab-content">
          <mat-card>
            <mat-card-header>
              <mat-card-title>AI Action Safety</mat-card-title>
            </mat-card-header>
            <mat-card-content>
              <p class="hint">
                Configure which AI-recommended actions are auto-executed and which require operator approval.
                Unknown action types always default to requiring approval.
              </p>

              @if (actionSafetyLoading()) {
                <mat-spinner diameter="24"></mat-spinner>
              } @else {
                <table mat-table [dataSource]="actionSafetyRows()" class="full-table action-safety-table">
                  <ng-container matColumnDef="actionType">
                    <th mat-header-cell *matHeaderCellDef>Action Type</th>
                    <td mat-cell *matCellDef="let row">
                      <span class="action-type-label">{{ formatActionType(row.actionType) }}</span>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="level">
                    <th mat-header-cell *matHeaderCellDef>Safety Level</th>
                    <td mat-cell *matCellDef="let row">
                      <mat-slide-toggle
                        [checked]="row.level === 'auto'"
                        (change)="toggleActionSafety(row.actionType, $event.checked ? 'auto' : 'approval')"
                        color="primary"
                      >
                        {{ row.level === 'auto' ? 'Auto-execute' : 'Require Approval' }}
                      </mat-slide-toggle>
                    </td>
                  </ng-container>

                  <tr mat-header-row *matHeaderRowDef="actionSafetyColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: actionSafetyColumns;"></tr>
                </table>

                <mat-card-actions align="end">
                  <button
                    mat-raised-button
                    color="primary"
                    (click)="saveActionSafety()"
                    [disabled]="actionSafetySaving()"
                  >
                    @if (actionSafetySaving()) {
                      <mat-spinner diameter="18" class="inline-spinner"></mat-spinner>
                    }
                    Save
                  </button>
                </mat-card-actions>
              }
            </mat-card-content>
          </mat-card>
        </div>
      </mat-tab>
      <!-- Analysis Strategy tab -->
      <mat-tab label="Analysis Strategy">
        <div class="tab-content">
          <mat-card>
            <mat-card-header>
              <mat-card-title>Analysis Strategy</mat-card-title>
            </mat-card-header>
            <mat-card-content>
              <p class="hint">
                Configure how the AI investigates tickets during agentic analysis.
                <strong>Full Context</strong> sends the entire conversation history on each iteration (higher quality, higher cost).
                <strong>Orchestrated</strong> uses Opus as a strategist to assign parallel tasks to smaller models with a growing knowledge document (lower cost).
              </p>

              @if (analysisStrategyLoading()) {
                <mat-spinner diameter="24"></mat-spinner>
              } @else {
                <mat-form-field class="full-width">
                  <mat-label>Strategy</mat-label>
                  <mat-select [value]="analysisStrategy()" (selectionChange)="analysisStrategy.set($event.value)">
                    <mat-option value="full_context">Full Context (brute force)</mat-option>
                    <mat-option value="orchestrated">Orchestrated (parallel tasks)</mat-option>
                  </mat-select>
                </mat-form-field>

                @if (analysisStrategy() === 'orchestrated') {
                  <mat-form-field class="full-width">
                    <mat-label>Max Parallel Tasks</mat-label>
                    <input matInput type="number" [value]="analysisMaxParallel()" (input)="analysisMaxParallel.set(+$any($event.target).value)" min="1" max="10">
                    <mat-hint>Number of sub-tasks to run concurrently (1-10)</mat-hint>
                  </mat-form-field>
                }

                <mat-card-actions align="end">
                  <button
                    mat-raised-button
                    color="primary"
                    (click)="saveAnalysisStrategy()"
                    [disabled]="analysisStrategySaving()"
                  >
                    @if (analysisStrategySaving()) {
                      <mat-spinner diameter="18" class="inline-spinner"></mat-spinner>
                    }
                    Save
                  </button>
                </mat-card-actions>
              }
            </mat-card-content>
          </mat-card>
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
  styles: [`
    h1 { margin: 0 0 24px; }
    .full-width { width: 100%; }
    .hint { color: #666; margin-bottom: 16px; font-size: 14px; }
    .section-card { margin-top: 24px; }
    .section-card mat-card-header {
      display: flex;
      align-items: center;
    }
    .header-spacer { flex: 1; }
    .tab-content { padding-top: 24px; }
    .full-table { width: 100%; }
    .endpoint-text { font-family: monospace; font-size: 13px; color: #555; }
    .check-type-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: #e3f2fd;
      color: #1565c0;
      font-family: monospace;
    }
    .monitored-yes { color: #4caf50; font-size: 20px; }
    .monitored-no { color: #9e9e9e; font-size: 20px; }
    .empty-state {
      text-align: center;
      padding: 32px 16px;
      color: #888;
    }
    .empty-state mat-icon {
      font-size: 48px;
      width: 48px;
      height: 48px;
      color: #ccc;
    }
    .empty-state p { margin: 8px 0; }
    .delete-action { color: #c62828; }
    code {
      font-size: 12px;
      padding: 2px 6px;
      background: #f5f5f5;
      border-radius: 3px;
      font-family: monospace;
    }
    .color-swatch {
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: 1px solid #ddd;
    }
    .desc-text {
      font-size: 13px;
      color: #666;
    }
    .class-chip {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 10px;
      border-radius: 12px;
      text-transform: uppercase;
    }
    .class-open {
      background: #e3f2fd;
      color: #1565c0;
    }
    .class-closed {
      background: #fce4ec;
      color: #c62828;
    }
    .alert-toggle-row {
      display: flex;
      flex-direction: column;
      margin-bottom: 16px;
    }
    .alert-toggles {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .alert-desc {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
      padding-left: 48px;
    }
    h3 {
      margin: 24px 0 8px;
      font-size: 16px;
      font-weight: 500;
    }
    .inline-spinner {
      display: inline-block;
      margin-right: 8px;
      vertical-align: middle;
    }
    .action-type-label {
      font-family: monospace;
      font-size: 13px;
      font-weight: 500;
    }
    .action-safety-table { margin-bottom: 16px; }
  `],
})
export class SettingsComponent implements OnInit {
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
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

  // External Services tab
  services = signal<ExternalService[]>([]);
  svcColumns = ['name', 'endpoint', 'checkType', 'monitored', 'svcActions'];

  // Statuses tab
  statuses = signal<TicketStatusConfig[]>([]);
  statusesLoading = signal(true);
  statusesError = signal(false);
  statusColumns = ['color', 'value', 'displayName', 'description', 'statusClass', 'sortOrder', 'active', 'statusActions'];

  // Categories tab
  categories = signal<TicketCategoryConfig[]>([]);
  categoriesLoading = signal(true);
  categoriesError = signal(false);
  catColumns = ['catColor', 'catValue', 'catDisplayName', 'catDescription', 'catSortOrder', 'catActive', 'catActions'];

  // Operational Alerts tab
  alertConfig = signal<OperationalAlertConfig>({
    enabled: false,
    recipientEmail: '',
    throttleMinutes: 60,
    alerts: {
      failedJobs: true,
      probeMisses: true,
      aiProviderDown: true,
      devopsSyncStale: true,
      summarizationStale: true,
    },
  });
  alertsLoading = signal(true);
  alertsError = signal(false);
  alertsSaving = signal(false);
  alertsTesting = signal(false);

  // Action Safety tab
  actionSafetyConfig = signal<Record<string, 'auto' | 'approval'>>({});
  actionSafetyLoading = signal(true);
  actionSafetySaving = signal(false);
  actionSafetyColumns = ['actionType', 'level'];
  actionSafetyRows = signal<Array<{ actionType: string; level: 'auto' | 'approval' }>>([]);

  // Analysis Strategy tab
  analysisStrategy = signal<'full_context' | 'orchestrated'>('full_context');
  analysisMaxParallel = signal(3);
  analysisStrategyLoading = signal(true);
  analysisStrategySaving = signal(false);

  selectedTab = signal(0);

  ngOnInit(): void {
    const tabParam = this.route.snapshot.queryParamMap.get('tab');
    if (tabParam !== null) {
      const tab = Number(tabParam);
      if (Number.isInteger(tab) && tab >= 0 && tab <= 6) this.selectedTab.set(tab);
    }
    this.loadUsers();
    this.loadSuperAdmin();
    this.loadServices();
    this.loadStatuses();
    this.loadCategories();
    this.loadAlertConfig();
    this.loadActionSafety();
    this.loadAnalysisStrategy();
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    this.router.navigate([], { queryParams: { tab: index }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  // ─── General tab ───

  saveKey(): void {
    sessionStorage.setItem('rc_api_key', this.apiKey);
    this.snackBar.open('API key saved', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
  }

  clearKey(): void {
    this.apiKey = '';
    sessionStorage.removeItem('rc_api_key');
    this.snackBar.open('API key cleared', 'OK', { duration: 3000 });
  }

  loadUsers(): void {
    this.usersLoading.set(true);
    this.userSvc.getUsers().subscribe({
      next: (users) => {
        this.adminUsers.set(users.filter(u => u.isActive && (u.role === 'ADMIN' || u.role === 'OPERATOR')));
        this.usersLoading.set(false);
      },
      error: (err) => {
        this.usersLoading.set(false);
        // 403 is expected for OPERATOR users — silently leave dropdown empty
        if (err?.status !== 403) {
          this.snackBar.open('Failed to load users', 'OK', { duration: 5000 });
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
        this.snackBar.open('Failed to load super admin setting', 'OK', { duration: 5000 });
      },
    });
  }

  saveSuperAdmin(): void {
    this.superAdminSaving.set(true);
    this.settingsSvc.setSuperAdminUserId(this.superAdminUserId).subscribe({
      next: (result) => {
        this.superAdminUserId = result.userId;
        this.superAdminSaving.set(false);
        this.snackBar.open('Super admin saved', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
      },
      error: () => {
        this.superAdminSaving.set(false);
        this.snackBar.open('Failed to save super admin', 'OK', { duration: 5000 });
      },
    });
  }

  loadServices(): void {
    this.extSvc.getAll().subscribe({
      next: (list) => this.services.set(list),
      error: () => this.snackBar.open('Failed to load external services', 'OK', { duration: 5000 }),
    });
  }

  addService(): void {
    const ref = this.dialog.open(ExternalServiceDialogComponent, {
      width: '500px',
      data: {},
    });
    ref.afterClosed().subscribe((saved) => {
      if (saved) this.loadServices();
    });
  }

  editService(svc: ExternalService): void {
    const ref = this.dialog.open(ExternalServiceDialogComponent, {
      width: '500px',
      data: { service: svc },
    });
    ref.afterClosed().subscribe((saved) => {
      if (saved) this.loadServices();
    });
  }

  toggleMonitored(svc: ExternalService): void {
    this.extSvc.update(svc.id, { isMonitored: !svc.isMonitored }).subscribe({
      next: () => {
        this.snackBar.open(
          `${svc.name} monitoring ${svc.isMonitored ? 'disabled' : 'enabled'}`,
          'OK',
          { duration: 3000, panelClass: 'success-snackbar' },
        );
        this.loadServices();
      },
      error: () => this.snackBar.open('Failed to update', 'OK', { duration: 5000 }),
    });
  }

  deleteService(svc: ExternalService): void {
    if (!confirm(`Delete "${svc.name}"? This cannot be undone.`)) return;
    this.extSvc.delete(svc.id).subscribe({
      next: () => {
        this.snackBar.open(`${svc.name} deleted`, 'OK', { duration: 3000, panelClass: 'success-snackbar' });
        this.loadServices();
      },
      error: () => this.snackBar.open('Failed to delete', 'OK', { duration: 5000 }),
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
        this.snackBar.open('Failed to load status configs', 'OK', { duration: 5000 });
      },
    });
  }

  createStatus(): void {
    const ref = this.dialog.open(StatusConfigDialogComponent, {
      width: '500px',
      data: {},
    });
    ref.afterClosed().subscribe((saved) => {
      if (saved) this.loadStatuses();
    });
  }

  editStatus(config: TicketStatusConfig): void {
    const ref = this.dialog.open(StatusConfigDialogComponent, {
      width: '500px',
      data: { config },
    });
    ref.afterClosed().subscribe((saved) => {
      if (saved) this.loadStatuses();
    });
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
        this.snackBar.open('Failed to load category configs', 'OK', { duration: 5000 });
      },
    });
  }

  createCategory(): void {
    const ref = this.dialog.open(CategoryConfigDialogComponent, {
      width: '500px',
      data: {},
    });
    ref.afterClosed().subscribe((saved) => {
      if (saved) this.loadCategories();
    });
  }

  editCategory(config: TicketCategoryConfig): void {
    const ref = this.dialog.open(CategoryConfigDialogComponent, {
      width: '500px',
      data: { config },
    });
    ref.afterClosed().subscribe((saved) => {
      if (saved) this.loadCategories();
    });
  }

  // ─── Operational Alerts tab ───

  loadAlertConfig(): void {
    this.alertsLoading.set(true);
    this.alertsError.set(false);
    this.settingsSvc.getOperationalAlerts().subscribe({
      next: (config) => {
        this.alertConfig.set(config);
        this.alertsLoading.set(false);
      },
      error: () => {
        this.alertsLoading.set(false);
        this.alertsError.set(true);
        this.snackBar.open('Failed to load alert configuration', 'OK', { duration: 5000 });
      },
    });
  }

  setAlertEnabled(value: boolean): void {
    this.alertConfig.update(c => ({ ...c, enabled: value }));
  }

  setAlertRecipientEmail(value: string): void {
    this.alertConfig.update(c => ({ ...c, recipientEmail: value }));
  }

  setAlertThrottleMinutes(value: number): void {
    this.alertConfig.update(c => ({ ...c, throttleMinutes: value }));
  }

  setAlertType(key: keyof OperationalAlertConfig['alerts'], value: boolean): void {
    this.alertConfig.update(c => ({ ...c, alerts: { ...c.alerts, [key]: value } }));
  }

  saveAlertConfig(): void {
    this.alertsSaving.set(true);
    this.settingsSvc.updateOperationalAlerts(this.alertConfig()).subscribe({
      next: (saved) => {
        this.alertConfig.set(saved);
        this.alertsSaving.set(false);
        this.snackBar.open('Alert configuration saved', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
      },
      error: () => {
        this.alertsSaving.set(false);
        this.snackBar.open('Failed to save alert configuration', 'OK', { duration: 5000 });
      },
    });
  }

  testAlert(): void {
    this.alertsTesting.set(true);
    this.settingsSvc.testOperationalAlert().subscribe({
      next: (result) => {
        this.alertsTesting.set(false);
        if (result.success) {
          this.snackBar.open(result.message ?? 'Test alert sent', 'OK', { duration: 5000, panelClass: 'success-snackbar' });
        } else {
          this.snackBar.open(`Test failed: ${result.error}`, 'OK', { duration: 8000 });
        }
      },
      error: (err) => {
        this.alertsTesting.set(false);
        const msg = err?.error?.error ?? 'Failed to send test alert';
        this.snackBar.open(msg, 'OK', { duration: 8000 });
      },
    });
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
        this.snackBar.open('Failed to load action safety config', 'OK', { duration: 5000 });
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
        this.snackBar.open('Action safety config saved', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
      },
      error: () => {
        this.actionSafetySaving.set(false);
        this.snackBar.open('Failed to save action safety config', 'OK', { duration: 5000 });
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
        this.analysisStrategyLoading.set(false);
      },
      error: () => {
        this.analysisStrategyLoading.set(false);
        this.snackBar.open('Failed to load analysis strategy config', 'OK', { duration: 5000 });
      },
    });
  }

  saveAnalysisStrategy(): void {
    this.analysisStrategySaving.set(true);
    const config = {
      strategy: this.analysisStrategy(),
      maxParallelTasks: Math.min(10, Math.max(1, this.analysisMaxParallel())),
    };
    this.settingsSvc.saveAnalysisStrategy(config).subscribe({
      next: (saved) => {
        this.analysisStrategy.set(saved.strategy);
        this.analysisMaxParallel.set(saved.maxParallelTasks);
        this.analysisStrategySaving.set(false);
        this.snackBar.open('Analysis strategy saved', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
      },
      error: () => {
        this.analysisStrategySaving.set(false);
        this.snackBar.open('Failed to save analysis strategy', 'OK', { duration: 5000 });
      },
    });
  }
}
