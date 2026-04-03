import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { environment } from '../../../environments/environment';
import {
  DEFAULT_OPERATIONAL_ALERT_CONFIG,
  OperationalAlertConfig,
} from '../../core/services/settings.service';

interface NotificationPreference {
  id: string;
  event: string;
  description: string;
  emailEnabled: boolean;
  slackEnabled: boolean;
  slackTarget: string | null;
  emailTarget: string | null;
  isActive: boolean;
}

interface OperatorOption {
  id: string;
  name: string;
  email: string;
  slackUserId: string | null;
  isActive: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  TICKET_CREATED: 'New Ticket',
  ANALYSIS_COMPLETE: 'Analysis Complete',
  SUFFICIENCY_CHANGED: 'Sufficiency Changed',
  USER_REPLIED: 'User Replied',
  PLAN_READY: 'Plan Ready',
  PLAN_APPROVED: 'Plan Approved',
  PLAN_REJECTED: 'Plan Rejected',
  RESOLUTION_COMPLETE: 'Resolution Complete',
  SERVICE_HEALTH_ALERT: 'Service Health Alert',
  PROBE_ALERT: 'Probe Alert',
};

const SLACK_TARGET_OPTIONS = [
  { value: 'default', label: 'Default Channel' },
  { value: 'assigned_operator', label: 'Assigned Operator (DM)' },
  { value: 'all_operators', label: 'All Operators (DM each)' },
  { value: 'specific_operator', label: 'Specific Operator' },
  { value: 'custom', label: 'Custom Channel ID' },
];

const EMAIL_TARGET_OPTIONS = [
  { value: 'all_operators', label: 'All Operators' },
  { value: 'assigned_operator', label: 'Assigned Operator' },
  { value: 'specific_operator', label: 'Specific Operator' },
  { value: 'custom', label: 'Custom Email' },
];

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatTableModule,
    MatSlideToggleModule,
    MatSelectModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTabsModule,
  ],
  template: `
    <h1>Notifications</h1>
    <p class="subtitle">Configure event notifications and operational alerts.</p>

    <mat-tab-group>

      <mat-tab label="Event Notifications">
        @if (loading()) {
          <div class="spinner-wrapper"><mat-spinner diameter="40" /></div>
        } @else {
          <mat-card>
            <mat-card-content>
              <div class="table-wrapper">
                <table mat-table [dataSource]="preferences()" class="pref-table">

                  <ng-container matColumnDef="event">
                    <th mat-header-cell *matHeaderCellDef>Event</th>
                    <td mat-cell *matCellDef="let pref">
                      <div class="event-cell">
                        <strong>{{ eventLabel(pref.event) }}</strong>
                        <span class="event-desc">{{ pref.description }}</span>
                      </div>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="emailEnabled">
                    <th mat-header-cell *matHeaderCellDef>Email</th>
                    <td mat-cell *matCellDef="let pref">
                      <mat-slide-toggle [(ngModel)]="pref.emailEnabled" />
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="emailTarget">
                    <th mat-header-cell *matHeaderCellDef>Email Target</th>
                    <td mat-cell *matCellDef="let pref">
                      @if (pref.emailEnabled) {
                        <mat-form-field appearance="outline" class="compact-field">
                          <mat-select [value]="emailTargetSelection(pref)" (selectionChange)="onEmailTargetChange(pref, $event.value)">
                            @for (opt of emailTargetOptions; track opt.value) {
                              <mat-option [value]="opt.value">{{ opt.label }}</mat-option>
                            }
                          </mat-select>
                        </mat-form-field>
                        @if (emailTargetSelection(pref) === 'custom') {
                          <mat-form-field appearance="outline" class="compact-field custom-input">
                            <input matInput [(ngModel)]="pref.emailTarget" placeholder="user@example.com">
                          </mat-form-field>
                        }
                        @if (emailTargetSelection(pref) === 'specific_operator') {
                          <mat-form-field appearance="outline" class="compact-field custom-input">
                            <mat-select
                              [value]="selectedOperatorValue(pref.emailTarget)"
                              (selectionChange)="pref.emailTarget = $event.value"
                              placeholder="Select operator">
                              @for (op of operators(); track op.id) {
                                <mat-option [value]="'operator:' + op.id">{{ op.name }}</mat-option>
                              }
                            </mat-select>
                          </mat-form-field>
                        }
                      }
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="slackEnabled">
                    <th mat-header-cell *matHeaderCellDef>Slack</th>
                    <td mat-cell *matCellDef="let pref">
                      <mat-slide-toggle [(ngModel)]="pref.slackEnabled" />
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="slackTarget">
                    <th mat-header-cell *matHeaderCellDef>Slack Target</th>
                    <td mat-cell *matCellDef="let pref">
                      @if (pref.slackEnabled) {
                        <mat-form-field appearance="outline" class="compact-field">
                          <mat-select [value]="slackTargetSelection(pref)" (selectionChange)="onSlackTargetChange(pref, $event.value)">
                            @for (opt of slackTargetOptions; track opt.value) {
                              <mat-option [value]="opt.value">{{ opt.label }}</mat-option>
                            }
                          </mat-select>
                        </mat-form-field>
                        @if (slackTargetSelection(pref) === 'custom') {
                          <mat-form-field appearance="outline" class="compact-field custom-input">
                            <input matInput [(ngModel)]="pref.slackTarget" placeholder="C0123456789">
                          </mat-form-field>
                        }
                        @if (slackTargetSelection(pref) === 'specific_operator') {
                          <mat-form-field appearance="outline" class="compact-field custom-input">
                            <mat-select
                              [value]="selectedOperatorValue(pref.slackTarget)"
                              (selectionChange)="pref.slackTarget = $event.value"
                              placeholder="Select operator">
                              @for (op of operators(); track op.id) {
                                <mat-option [value]="'operator:' + op.id">{{ op.name }}</mat-option>
                              }
                            </mat-select>
                          </mat-form-field>
                        }
                      }
                    </td>
                  </ng-container>

                  <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
                </table>
              </div>

              <div class="actions">
                <button mat-flat-button color="primary" (click)="saveAll()" [disabled]="saving()">
                  @if (saving()) {
                    <mat-spinner diameter="20" />
                  } @else {
                    <mat-icon>save</mat-icon>
                    Save All
                  }
                </button>
              </div>
            </mat-card-content>
          </mat-card>
        }
      </mat-tab>

      <mat-tab label="Operational Alerts">
        <div class="tab-content">
          @if (alertsLoading()) {
            <div class="spinner-wrapper"><mat-spinner diameter="40" /></div>
          } @else if (alertsError()) {
            <p>Failed to load alert configuration. <button mat-button (click)="loadAlertConfig()">Retry</button></p>
          } @else {
            <mat-card>
              <mat-card-header>
                <mat-card-title>Alert Notifications</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <p class="subtitle">
                  Get email notifications when background processes fail silently.
                </p>

                <div class="alert-toggle-row">
                  <mat-slide-toggle
                    [checked]="alertConfig().enabled"
                    (change)="setAlertEnabled($event.checked)">
                    Enable operational alerts
                  </mat-slide-toggle>
                </div>

                <mat-form-field appearance="outline" class="full-width">
                  <mat-label>Recipient Operator</mat-label>
                  <mat-select
                    [value]="alertConfig().recipientOperatorId"
                    (selectionChange)="setAlertRecipientOperator($event.value)">
                    @for (op of operators(); track op.id) {
                      <mat-option [value]="op.id">{{ op.name }} ({{ op.email }})</mat-option>
                    }
                  </mat-select>
                </mat-form-field>

                <mat-form-field appearance="outline" class="full-width">
                  <mat-label>Throttle (minutes between repeat alerts)</mat-label>
                  <mat-select
                    [value]="alertConfig().throttleMinutes"
                    (selectionChange)="setAlertThrottleMinutes($event.value)">
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

                @if (alertTestResult()) {
                  <div class="test-result" [class.success]="alertTestResult()!.success" [class.error]="!alertTestResult()!.success">
                    {{ alertTestResult()!.success ? alertTestResult()!.message : alertTestResult()!.error }}
                  </div>
                }
              </mat-card-content>
              <mat-card-actions>
                <button mat-flat-button color="primary" (click)="saveAlertConfig()" [disabled]="alertsSaving()">
                  @if (alertsSaving()) { <mat-spinner diameter="18" /> } @else { <mat-icon>save</mat-icon> }
                  Save
                </button>
                <button mat-button (click)="testAlert()" [disabled]="alertsTesting()">
                  @if (alertsTesting()) { <mat-spinner diameter="18" /> }
                  Test Alert
                </button>
              </mat-card-actions>
            </mat-card>
          }
        </div>
      </mat-tab>

    </mat-tab-group>
  `,
  styles: [`
    .subtitle {
      color: #666;
      margin-bottom: 16px;
    }
    .spinner-wrapper {
      display: flex;
      justify-content: center;
      padding: 40px;
    }
    .table-wrapper {
      overflow-x: auto;
    }
    .pref-table {
      width: 100%;
    }
    .event-cell {
      display: flex;
      flex-direction: column;
      padding: 8px 0;
    }
    .event-desc {
      font-size: 12px;
      color: #888;
      margin-top: 2px;
    }
    .compact-field {
      font-size: 13px;
      max-width: 200px;
    }
    .custom-input {
      margin-left: 8px;
      max-width: 180px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid #e0e0e0;
    }
    .actions button mat-icon {
      margin-right: 4px;
    }
    .tab-content {
      padding-top: 16px;
    }
    .full-width {
      width: 100%;
      max-width: 400px;
      display: block;
      margin-bottom: 12px;
    }
    .alert-toggle-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .alert-toggles {
      display: flex;
      flex-direction: column;
    }
    .alert-desc {
      font-size: 12px;
      color: #888;
    }
    .test-result {
      margin-top: 8px;
      padding: 8px;
      border-radius: 4px;
      font-size: 13px;
    }
    .test-result.success { background: #e8f5e9; color: #2e7d32; }
    .test-result.error { background: #fce4ec; color: #c62828; }
  `],
})
export class NotificationPreferencesComponent implements OnInit {
  private http = inject(HttpClient);
  private snackBar = inject(MatSnackBar);

  loading = signal(true);
  saving = signal(false);
  preferences = signal<NotificationPreference[]>([]);
  operators = signal<OperatorOption[]>([]);

  alertConfig = signal<OperationalAlertConfig>({ ...DEFAULT_OPERATIONAL_ALERT_CONFIG });
  alertsLoading = signal(false);
  alertsError = signal(false);
  alertsSaving = signal(false);
  alertsTesting = signal(false);
  alertTestResult = signal<{ success: boolean; message?: string; error?: string } | null>(null);

  displayedColumns = ['event', 'emailEnabled', 'emailTarget', 'slackEnabled', 'slackTarget'];
  slackTargetOptions = SLACK_TARGET_OPTIONS;
  emailTargetOptions = EMAIL_TARGET_OPTIONS;

  ngOnInit(): void {
    this.load();
    this.loadOperators();
    this.loadAlertConfig();
  }

  private loadOperators(): void {
    this.http.get<OperatorOption[]>(`${environment.apiUrl}/operators`).subscribe({
      next: ops => this.operators.set(ops.filter(o => o.isActive !== false)),
      error: () => { /* non-critical */ },
    });
  }

  eventLabel(event: string): string {
    return EVENT_LABELS[event] ?? event;
  }

  slackTargetSelection(pref: NotificationPreference): string {
    if (pref.slackTarget === null || pref.slackTarget === undefined) return 'default';
    if (pref.slackTarget === 'assigned_operator' || pref.slackTarget === 'all_operators') return pref.slackTarget;
    if (pref.slackTarget.startsWith('operator:')) return 'specific_operator';
    return 'custom';
  }

  emailTargetSelection(pref: NotificationPreference): string {
    if (pref.emailTarget === null || pref.emailTarget === undefined || pref.emailTarget === 'all_operators') return 'all_operators';
    if (pref.emailTarget === 'assigned_operator') return 'assigned_operator';
    if (pref.emailTarget.startsWith('operator:')) return 'specific_operator';
    return 'custom';
  }

  onSlackTargetChange(pref: NotificationPreference, value: string): void {
    if (value === 'default') {
      pref.slackTarget = null;
    } else if (value === 'custom') {
      pref.slackTarget = '';
    } else if (value === 'specific_operator') {
      pref.slackTarget = '';
    } else {
      pref.slackTarget = value;
    }
  }

  onEmailTargetChange(pref: NotificationPreference, value: string): void {
    if (value === 'custom' || value === 'specific_operator') {
      pref.emailTarget = '';
    } else {
      pref.emailTarget = value;
    }
  }

  selectedOperatorValue(target: string | null): string {
    if (target?.startsWith('operator:')) return target;
    return '';
  }

  private load(): void {
    this.loading.set(true);
    this.http.get<NotificationPreference[]>(`${environment.apiUrl}/notification-preferences`).subscribe({
      next: prefs => {
        this.preferences.set(prefs);
        this.loading.set(false);
      },
      error: () => {
        this.snackBar.open('Failed to load notification preferences', 'Dismiss', { duration: 5000 });
        this.loading.set(false);
      },
    });
  }

  saveAll(): void {
    this.saving.set(true);
    const payload = this.preferences().map(p => ({
      event: p.event,
      emailEnabled: p.emailEnabled,
      slackEnabled: p.slackEnabled,
      slackTarget: p.slackTarget || null,
      emailTarget: p.emailTarget || null,
      isActive: p.isActive,
    }));

    this.http.put(`${environment.apiUrl}/notification-preferences`, payload).subscribe({
      next: () => {
        this.snackBar.open('Preferences saved', 'Dismiss', { duration: 3000 });
        this.saving.set(false);
      },
      error: () => {
        this.snackBar.open('Failed to save preferences', 'Dismiss', { duration: 5000 });
        this.saving.set(false);
      },
    });
  }

  loadAlertConfig(): void {
    this.alertsLoading.set(true);
    this.alertsError.set(false);
    this.http.get<OperationalAlertConfig>(`${environment.apiUrl}/settings/operational-alerts`).subscribe({
      next: config => {
        this.alertConfig.set(config);
        this.alertsLoading.set(false);
      },
      error: () => {
        this.alertsError.set(true);
        this.alertsLoading.set(false);
      },
    });
  }

  setAlertEnabled(value: boolean): void {
    this.alertConfig.update(c => ({ ...c, enabled: value }));
  }

  setAlertRecipientOperator(operatorId: string): void {
    this.alertConfig.update(c => ({ ...c, recipientOperatorId: operatorId }));
  }

  setAlertThrottleMinutes(value: number): void {
    this.alertConfig.update(c => ({ ...c, throttleMinutes: value }));
  }

  setAlertType(key: keyof OperationalAlertConfig['alerts'], value: boolean): void {
    this.alertConfig.update(c => ({ ...c, alerts: { ...c.alerts, [key]: value } }));
  }

  saveAlertConfig(): void {
    this.alertsSaving.set(true);
    this.http.put<OperationalAlertConfig>(
      `${environment.apiUrl}/settings/operational-alerts`,
      this.alertConfig(),
    ).subscribe({
      next: saved => {
        this.alertConfig.set(saved);
        this.alertsSaving.set(false);
        this.snackBar.open('Alert configuration saved', 'Dismiss', { duration: 3000 });
      },
      error: () => {
        this.alertsSaving.set(false);
        this.snackBar.open('Failed to save alert configuration', 'Dismiss', { duration: 5000 });
      },
    });
  }

  testAlert(): void {
    this.alertsTesting.set(true);
    this.alertTestResult.set(null);
    this.http.post<{ success: boolean; message?: string; error?: string }>(
      `${environment.apiUrl}/settings/operational-alerts/test`,
      {},
    ).subscribe({
      next: result => {
        this.alertTestResult.set(result);
        this.alertsTesting.set(false);
      },
      error: (err) => {
        const serverError = err?.error?.error ?? err?.error?.message ?? 'Request failed';
        this.alertTestResult.set({ success: false, error: serverError });
        this.alertsTesting.set(false);
      },
    });
  }
}
