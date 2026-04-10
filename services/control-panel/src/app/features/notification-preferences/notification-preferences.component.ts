import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import {
  DEFAULT_OPERATIONAL_ALERT_CONFIG,
  OperationalAlertConfig,
} from '../../core/services/settings.service';
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
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

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

const TAB_LABELS = ['Event Notifications', 'Operational Alerts'] as const;

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
  ],
  template: `
    <div class="page-wrapper">
      <h1 class="page-title">Notifications</h1>
      <p class="subtitle">Configure event notifications and operational alerts.</p>

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">

        <app-tab label="Event Notifications">
          @if (loading()) {
            <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
          } @else {
            <app-card>
              <div class="table-wrapper">
                <app-data-table [data]="preferences()" [trackBy]="trackPref" [rowClickable]="false">
                  <app-data-column key="event" header="Event" [sortable]="false">
                    <ng-template #cell let-pref>
                      <div class="event-cell">
                        <strong>{{ eventLabel(pref.event) }}</strong>
                        <span class="event-desc">{{ pref.description }}</span>
                      </div>
                    </ng-template>
                  </app-data-column>

                  <app-data-column key="emailEnabled" header="Email" [sortable]="false" width="80px">
                    <ng-template #cell let-pref>
                      <app-toggle-switch
                        [checked]="pref.emailEnabled"
                        (checkedChange)="pref.emailEnabled = $event" />
                    </ng-template>
                  </app-data-column>

                  <app-data-column key="emailTarget" header="Email Target" [sortable]="false">
                    <ng-template #cell let-pref>
                      @if (pref.emailEnabled) {
                        <div class="target-controls">
                          <app-select
                            [value]="emailTargetSelection(pref)"
                            [options]="emailTargetOptions"
                            (valueChange)="onEmailTargetChange(pref, $event)" />
                          @if (emailTargetSelection(pref) === 'custom') {
                            <input class="text-input compact-input" [(ngModel)]="pref.emailTarget" placeholder="user@example.com">
                          }
                          @if (emailTargetSelection(pref) === 'specific_operator') {
                            <app-select
                              [value]="selectedOperatorValue(pref.emailTarget)"
                              [options]="operatorOptions()"
                              (valueChange)="pref.emailTarget = $event" />
                          }
                        </div>
                      }
                    </ng-template>
                  </app-data-column>

                  <app-data-column key="slackEnabled" header="Slack" [sortable]="false" width="80px">
                    <ng-template #cell let-pref>
                      <app-toggle-switch
                        [checked]="pref.slackEnabled"
                        (checkedChange)="pref.slackEnabled = $event" />
                    </ng-template>
                  </app-data-column>

                  <app-data-column key="slackTarget" header="Slack Target" [sortable]="false">
                    <ng-template #cell let-pref>
                      @if (pref.slackEnabled) {
                        <div class="target-controls">
                          <app-select
                            [value]="slackTargetSelection(pref)"
                            [options]="slackTargetOptions"
                            (valueChange)="onSlackTargetChange(pref, $event)" />
                          @if (slackTargetSelection(pref) === 'custom') {
                            <input class="text-input compact-input" [(ngModel)]="pref.slackTarget" placeholder="C0123456789">
                          }
                          @if (slackTargetSelection(pref) === 'specific_operator') {
                            <app-select
                              [value]="selectedOperatorValue(pref.slackTarget)"
                              [options]="operatorOptions()"
                              (valueChange)="pref.slackTarget = $event" />
                          }
                        </div>
                      }
                    </ng-template>
                  </app-data-column>
                </app-data-table>
              </div>

              <div class="card-actions">
                <app-bronco-button variant="primary" (click)="saveAll()" [disabled]="saving()">
                  @if (saving()) { <span class="loading-text">Saving...</span> } @else { <span>Save All</span> }
                </app-bronco-button>
              </div>
            </app-card>
          }
        </app-tab>

        <app-tab label="Operational Alerts">
          <div class="tab-content">
            @if (alertsLoading()) {
              <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
            } @else if (alertsError()) {
              <p>Failed to load alert configuration.
                <app-bronco-button variant="ghost" (click)="loadAlertConfig()">Retry</app-bronco-button>
              </p>
            } @else {
              <app-card>
                <h2 class="section-title">Alert Notifications</h2>
                <p class="subtitle">
                  Get email notifications when background processes fail silently.
                </p>

                <div class="alert-toggle-row">
                  <app-toggle-switch
                    label="Enable operational alerts"
                    [checked]="alertConfig().enabled"
                    (checkedChange)="setAlertEnabled($event)" />
                </div>

                <div class="form-grid">
                  <app-form-field label="Recipient Operator">
                    <app-select
                      [value]="alertConfig().recipientOperatorId"
                      [options]="operatorEmailOptions()"
                      (valueChange)="setAlertRecipientOperator($event)" />
                  </app-form-field>

                  <app-form-field label="Throttle (minutes between repeat alerts)">
                    <app-select
                      [value]="'' + alertConfig().throttleMinutes"
                      [options]="throttleOptions"
                      (valueChange)="setAlertThrottleMinutes(+$event)" />
                  </app-form-field>
                </div>

                <h3 class="subsection-title">Alert Types</h3>
                <div class="alert-toggles">
                  <div class="alert-toggle-row">
                    <app-toggle-switch
                      label="Failed BullMQ jobs"
                      [checked]="alertConfig().alerts.failedJobs"
                      (checkedChange)="setAlertType('failedJobs', $event)" />
                    <span class="alert-desc">Alert when background job queues have failed jobs</span>
                  </div>
                  <div class="alert-toggle-row">
                    <app-toggle-switch
                      label="Missed probe schedules"
                      [checked]="alertConfig().alerts.probeMisses"
                      (checkedChange)="setAlertType('probeMisses', $event)" />
                    <span class="alert-desc">Alert when scheduled probes miss their expected run window</span>
                  </div>
                  <div class="alert-toggle-row">
                    <app-toggle-switch
                      label="AI provider outages"
                      [checked]="alertConfig().alerts.aiProviderDown"
                      (checkedChange)="setAlertType('aiProviderDown', $event)" />
                    <span class="alert-desc">Alert when Ollama or cloud AI providers are unreachable or failing</span>
                  </div>
                  <div class="alert-toggle-row">
                    <app-toggle-switch
                      label="DevOps sync staleness"
                      [checked]="alertConfig().alerts.devopsSyncStale"
                      (checkedChange)="setAlertType('devopsSyncStale', $event)" />
                    <span class="alert-desc">Alert when Azure DevOps sync stops (PAT expired, rate limit, etc)</span>
                  </div>
                  <div class="alert-toggle-row">
                    <app-toggle-switch
                      label="Log summarization staleness"
                      [checked]="alertConfig().alerts.summarizationStale"
                      (checkedChange)="setAlertType('summarizationStale', $event)" />
                    <span class="alert-desc">Alert when log summarization hasn't run in over 2 hours</span>
                  </div>
                </div>

                @if (alertTestResult()) {
                  <div class="test-result" [class.success]="alertTestResult()!.success" [class.error]="!alertTestResult()!.success">
                    {{ alertTestResult()!.success ? alertTestResult()!.message : alertTestResult()!.error }}
                  </div>
                }

                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveAlertConfig()" [disabled]="alertsSaving()">
                    @if (alertsSaving()) { <span class="loading-text">Saving...</span> } @else { Save }
                  </app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="testAlert()" [disabled]="alertsTesting()">
                    @if (alertsTesting()) { <span class="loading-text">Testing...</span> } @else { Test Alert }
                  </app-bronco-button>
                </div>
              </app-card>
            }
          </div>
        </app-tab>

      </app-tab-group>
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-title {
      margin: 0 0 8px;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .subtitle {
      color: var(--text-tertiary);
      margin: 0 0 16px;
      font-size: 14px;
    }

    .loading-wrapper {
      display: flex;
      justify-content: center;
      padding: 40px;
    }
    .loading-text {
      color: var(--text-tertiary);
      font-size: 13px;
    }

    .section-title {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .subsection-title {
      margin: 24px 0 8px;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .table-wrapper { overflow-x: auto; }

    .event-cell {
      display: flex;
      flex-direction: column;
      padding: 4px 0;
    }
    .event-desc {
      font-size: 12px;
      color: var(--text-tertiary);
      margin-top: 2px;
    }

    .target-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .target-controls app-select {
      max-width: 200px;
    }
    .compact-input {
      max-width: 180px;
    }

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

    .card-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
    }

    .tab-content { padding-top: 8px; }

    .form-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 400px;
      margin-bottom: 12px;
    }

    .alert-toggle-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .alert-toggles {
      display: flex;
      flex-direction: column;
    }
    .alert-desc {
      font-size: 12px;
      color: var(--text-tertiary);
      padding-left: 44px;
    }
    .test-result {
      margin-top: 8px;
      padding: 8px 12px;
      border-radius: var(--radius-md);
      font-size: 13px;
    }
    .test-result.success { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .test-result.error { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }
  `],
})
export class NotificationPreferencesComponent implements OnInit {
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  selectedTab = signal(0);
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

  slackTargetOptions = SLACK_TARGET_OPTIONS;
  emailTargetOptions = EMAIL_TARGET_OPTIONS;

  throttleOptions = [
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '120', label: '2 hours' },
  ];

  trackPref = (pref: NotificationPreference) => pref.id;

  operatorOptions = signal<Array<{ value: string; label: string }>>([
    { value: 'operator:', label: 'Select operator' },
  ]);
  operatorEmailOptions = signal<Array<{ value: string; label: string }>>([
    { value: '', label: 'Select operator' },
  ]);

  ngOnInit(): void {
    const tabSlug = this.route.snapshot.queryParamMap.get('tab');
    if (tabSlug) {
      const idx = TAB_LABELS.findIndex(l => this.toSlug(l) === tabSlug);
      if (idx >= 0) this.selectedTab.set(idx);
    }
    this.load();
    this.loadOperators();
    this.loadAlertConfig();
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

  private loadOperators(): void {
    this.http.get<OperatorOption[]>(`${environment.apiUrl}/operators`).subscribe({
      next: ops => {
        const active = ops.filter(o => o.isActive !== false);
        this.operators.set(active);
        this.operatorOptions.set([
          { value: 'operator:', label: 'Select operator' },
          ...active.map(o => ({ value: 'operator:' + o.id, label: o.name })),
        ]);
        this.operatorEmailOptions.set([
          { value: '', label: 'Select operator' },
          ...active.map(o => ({ value: o.id, label: `${o.name} (${o.email})` })),
        ]);
      },
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
      pref.slackTarget = 'operator:';
    } else {
      pref.slackTarget = value;
    }
  }

  onEmailTargetChange(pref: NotificationPreference, value: string): void {
    if (value === 'custom') {
      pref.emailTarget = '';
    } else if (value === 'specific_operator') {
      pref.emailTarget = 'operator:';
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
        this.toast.error('Failed to load notification preferences');
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
      slackTarget: (p.slackTarget && p.slackTarget !== 'operator:') ? p.slackTarget : null,
      emailTarget: (p.emailTarget && p.emailTarget !== 'operator:') ? p.emailTarget : null,
      isActive: p.isActive,
    }));

    this.http.put(`${environment.apiUrl}/notification-preferences`, payload).subscribe({
      next: () => {
        this.toast.success('Preferences saved');
        this.saving.set(false);
      },
      error: () => {
        this.toast.error('Failed to save preferences');
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
        this.toast.success('Alert configuration saved');
      },
      error: () => {
        this.alertsSaving.set(false);
        this.toast.error('Failed to save alert configuration');
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
