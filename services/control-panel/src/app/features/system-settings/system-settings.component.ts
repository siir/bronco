import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  SettingsService,
  SmtpSystemConfig,
  DevOpsSystemConfig,
  GithubSystemConfig,
  ImapSystemConfig,
  SlackSystemConfig,
  PromptRetentionConfig,
} from '../../core/services/settings.service';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
  ToggleSwitchComponent,
  TabComponent,
  TabGroupComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

const TAB_LABELS = ['SMTP', 'Azure DevOps', 'GitHub', 'IMAP', 'Slack', 'Prompt Retention'] as const;

@Component({
  standalone: true,
  imports: [
    FormsModule,
    BroncoButtonComponent,
    CardComponent,
    FormFieldComponent,
    ToggleSwitchComponent,
    TabComponent,
    TabGroupComponent,
  ],
  template: `
    <div class="page-wrapper">
      <h1 class="page-title">System Settings</h1>

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">

        <!-- SMTP Tab -->
        <app-tab label="SMTP">
          <div class="tab-content">
            @if (loading()) {
              <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
            } @else {
              <app-card>
                <h2 class="section-title">SMTP Configuration</h2>
                <p class="hint">Configure the SMTP server used for sending emails. Password is encrypted at rest.</p>
                <div class="form-grid">
                  <app-form-field label="Host">
                    <input class="text-input" [(ngModel)]="smtp.host" placeholder="smtp.example.com">
                  </app-form-field>
                  <app-form-field label="Port">
                    <input class="text-input" type="number" [(ngModel)]="smtp.port" placeholder="587">
                  </app-form-field>
                  <app-form-field label="User">
                    <input class="text-input" [(ngModel)]="smtp.user" placeholder="user@example.com">
                  </app-form-field>
                  <app-form-field label="Password">
                    <input class="text-input" type="password" [(ngModel)]="smtp.password">
                  </app-form-field>
                  <app-form-field label="From Address">
                    <input class="text-input" [(ngModel)]="smtp.from" placeholder="noreply@example.com">
                  </app-form-field>
                  <app-form-field label="From Name (optional)">
                    <input class="text-input" [(ngModel)]="smtp.fromName" placeholder="Bronco">
                  </app-form-field>
                </div>
                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveSmtp()" [disabled]="saving()">
                    Save
                  </app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="testSmtp()" [disabled]="testing()">
                    @if (testing()) { Testing... } @else { Test Connection }
                  </app-bronco-button>
                </div>
              </app-card>
            }
          </div>
        </app-tab>

        <!-- Azure DevOps Tab -->
        <app-tab label="Azure DevOps">
          <div class="tab-content">
            @if (loading()) {
              <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
            } @else {
              <app-card>
                <h2 class="section-title">Azure DevOps Configuration</h2>
                <p class="hint">Configure the Azure DevOps integration for work item sync. PAT is encrypted at rest.</p>
                <div class="form-grid">
                  <app-form-field label="Organization URL">
                    <input class="text-input" [(ngModel)]="devops.orgUrl" placeholder="https://dev.azure.com/myorg">
                  </app-form-field>
                  <app-form-field label="Project">
                    <input class="text-input" [(ngModel)]="devops.project" placeholder="MyProject">
                  </app-form-field>
                  <app-form-field label="Personal Access Token">
                    <input class="text-input" type="password" [(ngModel)]="devops.pat">
                  </app-form-field>
                  <app-form-field label="Assigned User">
                    <input class="text-input" [(ngModel)]="devops.assignedUser" placeholder="user@example.com">
                  </app-form-field>
                  <app-form-field label="Client Short Code (optional)">
                    <input class="text-input" [(ngModel)]="devops.clientShortCode">
                  </app-form-field>
                  <app-form-field label="Poll Interval (seconds)">
                    <input class="text-input" type="number" [(ngModel)]="devops.pollIntervalSeconds" placeholder="120">
                  </app-form-field>
                </div>
                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveDevOps()" [disabled]="saving()">
                    Save
                  </app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="testDevOps()" [disabled]="testing()">
                    @if (testing()) { Testing... } @else { Test Connection }
                  </app-bronco-button>
                </div>
              </app-card>
            }
          </div>
        </app-tab>

        <!-- GitHub Tab -->
        <app-tab label="GitHub">
          <div class="tab-content">
            @if (loading()) {
              <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
            } @else {
              <app-card>
                <h2 class="section-title">GitHub Configuration</h2>
                <p class="hint">Configure the GitHub token used for repository access and release notes. Token is encrypted at rest.</p>
                <div class="form-grid">
                  <app-form-field label="Token">
                    <input class="text-input" type="password" [(ngModel)]="github.token">
                  </app-form-field>
                  <app-form-field label="Repository">
                    <input class="text-input" [(ngModel)]="github.repo" placeholder="owner/repo">
                  </app-form-field>
                </div>
                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveGithub()" [disabled]="saving()">
                    Save
                  </app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="testGithub()" [disabled]="testing()">
                    @if (testing()) { Testing... } @else { Test Connection }
                  </app-bronco-button>
                </div>
              </app-card>
            }
          </div>
        </app-tab>

        <!-- IMAP Tab -->
        <app-tab label="IMAP">
          <div class="tab-content">
            @if (loading()) {
              <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
            } @else {
              <app-card>
                <h2 class="section-title">IMAP Configuration</h2>
                <p class="hint">Configure the IMAP server used for polling inbound emails. Password is encrypted at rest.</p>
                <div class="form-grid">
                  <app-form-field label="Host">
                    <input class="text-input" [(ngModel)]="imap.host" placeholder="imap.example.com">
                  </app-form-field>
                  <app-form-field label="Port">
                    <input class="text-input" type="number" [(ngModel)]="imap.port" placeholder="993">
                  </app-form-field>
                  <app-form-field label="User">
                    <input class="text-input" [(ngModel)]="imap.user" placeholder="user@example.com">
                  </app-form-field>
                  <app-form-field label="Password">
                    <input class="text-input" type="password" [(ngModel)]="imap.password">
                  </app-form-field>
                  <app-form-field label="Poll Interval (seconds)">
                    <input class="text-input" type="number" [(ngModel)]="imap.pollIntervalSeconds" placeholder="60">
                  </app-form-field>
                </div>
                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveImap()" [disabled]="saving()">
                    Save
                  </app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="testImap()" [disabled]="testing()">
                    @if (testing()) { Testing... } @else { Test Connection }
                  </app-bronco-button>
                </div>
              </app-card>
            }
          </div>
        </app-tab>

        <!-- Slack Tab -->
        <app-tab label="Slack">
          <div class="tab-content">
            @if (loading()) {
              <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
            } @else {
              <app-card>
                <h2 class="section-title">Slack Configuration</h2>
                <p class="hint">Configure Slack integration for operator notifications via Socket Mode. Tokens are encrypted at rest.</p>
                <div class="form-grid">
                  <div class="toggle-row">
                    <app-toggle-switch
                      label="Enabled"
                      [checked]="slack.enabled"
                      (checkedChange)="slack.enabled = $event" />
                  </div>
                  <app-form-field label="Bot Token (xoxb-...)">
                    <input class="text-input" type="password" [(ngModel)]="slack.botToken" placeholder="xoxb-...">
                  </app-form-field>
                  <app-form-field label="App-Level Token (xapp-...)">
                    <input class="text-input" type="password" [(ngModel)]="slack.appToken" placeholder="xapp-...">
                  </app-form-field>
                  <app-form-field label="Default Channel ID">
                    <input class="text-input" [(ngModel)]="slack.defaultChannelId" placeholder="C0123456789">
                  </app-form-field>
                </div>
                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="saveSlack()" [disabled]="saving()">
                    Save
                  </app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="testSlack()" [disabled]="testing()">
                    @if (testing()) { Testing... } @else { Test Connection }
                  </app-bronco-button>
                </div>
              </app-card>
            }
          </div>
        </app-tab>

        <!-- Prompt Retention Tab -->
        <app-tab label="Prompt Retention">
          <div class="tab-content">
            @if (loading()) {
              <div class="loading-wrapper"><span class="loading-text">Loading...</span></div>
            } @else {
              <app-card>
                <h2 class="section-title">Prompt Retention Policy</h2>
                <p class="hint">Configure how long full AI prompt/response archives are retained before being summarized and deleted.</p>
                <div class="form-grid">
                  <app-form-field label="Full prompt retention (days)">
                    <input class="text-input" type="number" [(ngModel)]="promptRetention.fullRetentionDays" min="1" placeholder="30">
                  </app-form-field>
                  <app-form-field label="Summary retention (days after summarization)">
                    <input class="text-input" type="number" [(ngModel)]="promptRetention.summaryRetentionDays" min="1" placeholder="90">
                  </app-form-field>
                </div>
                <div class="card-actions">
                  <app-bronco-button variant="primary" (click)="savePromptRetention()" [disabled]="saving()">
                    Save
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
      margin: 0 0 24px;
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .tab-content { padding-top: 8px; }

    .loading-wrapper {
      display: flex;
      justify-content: center;
      padding: 48px;
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
    .hint {
      color: var(--text-tertiary);
      margin-bottom: 16px;
      font-size: 14px;
    }

    .form-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 600px;
    }

    .toggle-row { margin-bottom: 4px; }

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
  `],
})
export class SystemSettingsComponent implements OnInit {
  private settingsService = inject(SettingsService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  selectedTab = signal(0);
  loading = signal(true);
  saving = signal(false);
  testing = signal(false);

  smtp: SmtpSystemConfig = { host: '', port: 587, user: '', password: '', from: '', fromName: '' };
  devops: DevOpsSystemConfig = { orgUrl: '', project: '', pat: '', assignedUser: '', clientShortCode: '', pollIntervalSeconds: 120 };
  github: GithubSystemConfig = { token: '', repo: '' };
  imap: ImapSystemConfig = { host: '', port: 993, user: '', password: '', pollIntervalSeconds: 60 };
  slack: SlackSystemConfig = { botToken: '', appToken: '', defaultChannelId: '', enabled: false };
  promptRetention: PromptRetentionConfig = { fullRetentionDays: 30, summaryRetentionDays: 90 };

  ngOnInit(): void {
    const tabSlug = this.route.snapshot.queryParamMap.get('tab');
    if (tabSlug) {
      const idx = TAB_LABELS.findIndex(l => this.toSlug(l) === tabSlug);
      if (idx >= 0) this.selectedTab.set(idx);
    }
    this.loadAll();
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

  private loadAll(): void {
    this.loading.set(true);
    let pending = 6;
    const done = () => { if (--pending === 0) this.loading.set(false); };

    this.settingsService.getSmtpConfig().subscribe({
      next: (c) => { if (c) this.smtp = { ...this.smtp, ...c }; done(); },
      error: () => done(),
    });
    this.settingsService.getDevOpsConfig().subscribe({
      next: (c) => { if (c) this.devops = { ...this.devops, ...c }; done(); },
      error: () => done(),
    });
    this.settingsService.getGithubConfig().subscribe({
      next: (c) => { if (c) this.github = { ...this.github, ...c }; done(); },
      error: () => done(),
    });
    this.settingsService.getImapConfig().subscribe({
      next: (c) => { if (c) this.imap = { ...this.imap, ...c }; done(); },
      error: () => done(),
    });
    this.settingsService.getSlackConfig().subscribe({
      next: (c) => { if (c) this.slack = { ...this.slack, ...c }; done(); },
      error: () => done(),
    });
    this.settingsService.getPromptRetention().subscribe({
      next: (c) => { if (c) this.promptRetention = { ...this.promptRetention, ...c }; done(); },
      error: () => done(),
    });
  }

  saveSmtp(): void {
    this.saving.set(true);
    this.settingsService.updateSmtpConfig(this.smtp).subscribe({
      next: (c) => {
        this.smtp = { ...this.smtp, ...c };
        this.toast.success('SMTP config saved');
        this.saving.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Failed to save SMTP config');
        this.saving.set(false);
      },
    });
  }

  testSmtp(): void {
    this.testing.set(true);
    this.settingsService.testSmtpConfig().subscribe({
      next: (r) => {
        r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed');
        this.testing.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'SMTP test failed');
        this.testing.set(false);
      },
    });
  }

  saveDevOps(): void {
    this.saving.set(true);
    this.settingsService.updateDevOpsConfig(this.devops).subscribe({
      next: (c) => {
        this.devops = { ...this.devops, ...c };
        this.toast.success('DevOps config saved');
        this.saving.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Failed to save DevOps config');
        this.saving.set(false);
      },
    });
  }

  testDevOps(): void {
    this.testing.set(true);
    this.settingsService.testDevOpsConfig().subscribe({
      next: (r) => {
        r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed');
        this.testing.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'DevOps test failed');
        this.testing.set(false);
      },
    });
  }

  saveGithub(): void {
    this.saving.set(true);
    this.settingsService.updateGithubConfig(this.github).subscribe({
      next: (c) => {
        this.github = { ...this.github, ...c };
        this.toast.success('GitHub config saved');
        this.saving.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Failed to save GitHub config');
        this.saving.set(false);
      },
    });
  }

  testGithub(): void {
    this.testing.set(true);
    this.settingsService.testGithubConfig().subscribe({
      next: (r) => {
        r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed');
        this.testing.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'GitHub test failed');
        this.testing.set(false);
      },
    });
  }

  saveImap(): void {
    this.saving.set(true);
    this.settingsService.saveImapConfig(this.imap).subscribe({
      next: (c) => {
        this.imap = { ...this.imap, ...c };
        this.toast.success('IMAP config saved');
        this.saving.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Failed to save IMAP config');
        this.saving.set(false);
      },
    });
  }

  testImap(): void {
    this.testing.set(true);
    this.settingsService.testImapConnection().subscribe({
      next: (r) => {
        r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed');
        this.testing.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'IMAP test failed');
        this.testing.set(false);
      },
    });
  }

  saveSlack(): void {
    this.saving.set(true);
    this.settingsService.saveSlackConfig(this.slack).subscribe({
      next: (c) => {
        this.slack = { ...this.slack, ...c };
        this.toast.success('Slack config saved');
        this.saving.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Failed to save Slack config');
        this.saving.set(false);
      },
    });
  }

  testSlack(): void {
    this.testing.set(true);
    this.settingsService.testSlackConnection().subscribe({
      next: (r) => {
        r.success ? this.toast.success(r.message || 'Success') : this.toast.error(r.error || 'Test failed');
        this.testing.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Slack test failed');
        this.testing.set(false);
      },
    });
  }

  savePromptRetention(): void {
    this.saving.set(true);
    this.settingsService.savePromptRetention(this.promptRetention).subscribe({
      next: (c) => {
        this.promptRetention = { ...this.promptRetention, ...c };
        this.toast.success('Prompt retention config saved');
        this.saving.set(false);
      },
      error: (err) => {
        this.toast.error(err?.error?.message || 'Failed to save prompt retention config');
        this.saving.set(false);
      },
    });
  }
}
