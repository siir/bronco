import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import {
  SettingsService,
  SmtpSystemConfig,
  DevOpsSystemConfig,
  GithubSystemConfig,
} from '../../core/services/settings.service';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatTabsModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
  ],
  template: `
    <h1>System Settings</h1>

    <mat-tab-group [selectedIndex]="selectedTab()" (selectedTabChange)="onTabChange($event.index)">

      <!-- SMTP Tab -->
      <mat-tab label="SMTP">
        <div class="tab-content">
          @if (loading()) {
            <div class="spinner-wrapper"><mat-spinner diameter="40" /></div>
          } @else {
            <mat-card>
              <mat-card-header>
                <mat-card-title>SMTP Configuration</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <p class="hint">Configure the SMTP server used for sending emails. Password is encrypted at rest.</p>
                <div class="form-grid">
                  <mat-form-field class="full-width">
                    <mat-label>Host</mat-label>
                    <input matInput [(ngModel)]="smtp.host" placeholder="smtp.example.com">
                  </mat-form-field>
                  <mat-form-field>
                    <mat-label>Port</mat-label>
                    <input matInput type="number" [(ngModel)]="smtp.port" placeholder="587">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>User</mat-label>
                    <input matInput [(ngModel)]="smtp.user" placeholder="user@example.com">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>Password</mat-label>
                    <input matInput type="password" [(ngModel)]="smtp.password">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>From Address</mat-label>
                    <input matInput [(ngModel)]="smtp.from" placeholder="noreply@example.com">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>From Name (optional)</mat-label>
                    <input matInput [(ngModel)]="smtp.fromName" placeholder="Bronco">
                  </mat-form-field>
                </div>
              </mat-card-content>
              <mat-card-actions>
                <button mat-raised-button color="primary" (click)="saveSmtp()" [disabled]="saving()">
                  <mat-icon>save</mat-icon> Save
                </button>
                <button mat-stroked-button (click)="testSmtp()" [disabled]="testing()">
                  @if (testing()) {
                    <mat-spinner diameter="18" />
                  } @else {
                    <mat-icon>send</mat-icon>
                  }
                  Test Connection
                </button>
              </mat-card-actions>
            </mat-card>
          }
        </div>
      </mat-tab>

      <!-- Azure DevOps Tab -->
      <mat-tab label="Azure DevOps">
        <div class="tab-content">
          @if (loading()) {
            <div class="spinner-wrapper"><mat-spinner diameter="40" /></div>
          } @else {
            <mat-card>
              <mat-card-header>
                <mat-card-title>Azure DevOps Configuration</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <p class="hint">Configure the Azure DevOps integration for work item sync. PAT is encrypted at rest.</p>
                <div class="form-grid">
                  <mat-form-field class="full-width">
                    <mat-label>Organization URL</mat-label>
                    <input matInput [(ngModel)]="devops.orgUrl" placeholder="https://dev.azure.com/myorg">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>Project</mat-label>
                    <input matInput [(ngModel)]="devops.project" placeholder="MyProject">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>Personal Access Token</mat-label>
                    <input matInput type="password" [(ngModel)]="devops.pat">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>Assigned User</mat-label>
                    <input matInput [(ngModel)]="devops.assignedUser" placeholder="user@example.com">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>Client Short Code (optional)</mat-label>
                    <input matInput [(ngModel)]="devops.clientShortCode">
                  </mat-form-field>
                  <mat-form-field>
                    <mat-label>Poll Interval (seconds)</mat-label>
                    <input matInput type="number" [(ngModel)]="devops.pollIntervalSeconds" placeholder="120">
                  </mat-form-field>
                </div>
              </mat-card-content>
              <mat-card-actions>
                <button mat-raised-button color="primary" (click)="saveDevOps()" [disabled]="saving()">
                  <mat-icon>save</mat-icon> Save
                </button>
                <button mat-stroked-button (click)="testDevOps()" [disabled]="testing()">
                  @if (testing()) {
                    <mat-spinner diameter="18" />
                  } @else {
                    <mat-icon>send</mat-icon>
                  }
                  Test Connection
                </button>
              </mat-card-actions>
            </mat-card>
          }
        </div>
      </mat-tab>

      <!-- GitHub Tab -->
      <mat-tab label="GitHub">
        <div class="tab-content">
          @if (loading()) {
            <div class="spinner-wrapper"><mat-spinner diameter="40" /></div>
          } @else {
            <mat-card>
              <mat-card-header>
                <mat-card-title>GitHub Configuration</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <p class="hint">Configure the GitHub token used for repository access and release notes. Token is encrypted at rest.</p>
                <div class="form-grid">
                  <mat-form-field class="full-width">
                    <mat-label>Token</mat-label>
                    <input matInput type="password" [(ngModel)]="github.token">
                  </mat-form-field>
                  <mat-form-field class="full-width">
                    <mat-label>Repository</mat-label>
                    <input matInput [(ngModel)]="github.repo" placeholder="owner/repo">
                  </mat-form-field>
                </div>
              </mat-card-content>
              <mat-card-actions>
                <button mat-raised-button color="primary" (click)="saveGithub()" [disabled]="saving()">
                  <mat-icon>save</mat-icon> Save
                </button>
                <button mat-stroked-button (click)="testGithub()" [disabled]="testing()">
                  @if (testing()) {
                    <mat-spinner diameter="18" />
                  } @else {
                    <mat-icon>send</mat-icon>
                  }
                  Test Connection
                </button>
              </mat-card-actions>
            </mat-card>
          }
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
  styles: [`
    .tab-content {
      padding: 24px 0;
    }
    .hint {
      color: #666;
      margin-bottom: 16px;
      font-size: 14px;
    }
    .form-grid {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 600px;
    }
    .full-width {
      width: 100%;
    }
    .spinner-wrapper {
      display: flex;
      justify-content: center;
      padding: 48px;
    }
    mat-card-actions {
      display: flex;
      gap: 12px;
      padding: 16px !important;
    }
    mat-card-actions button mat-spinner {
      display: inline-block;
      margin-right: 4px;
    }
  `],
})
export class SystemSettingsComponent implements OnInit {
  private settingsService = inject(SettingsService);
  private snackBar = inject(MatSnackBar);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  selectedTab = signal(0);
  loading = signal(true);
  saving = signal(false);
  testing = signal(false);

  smtp: SmtpSystemConfig = { host: '', port: 587, user: '', password: '', from: '', fromName: '' };
  devops: DevOpsSystemConfig = { orgUrl: '', project: '', pat: '', assignedUser: '', clientShortCode: '', pollIntervalSeconds: 120 };
  github: GithubSystemConfig = { token: '', repo: '' };

  ngOnInit(): void {
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if (tab !== null) {
      const tabIndex = +tab;
      if (Number.isInteger(tabIndex) && tabIndex >= 0 && tabIndex <= 2) {
        this.selectedTab.set(tabIndex);
      }
    }
    this.loadAll();
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    this.router.navigate([], { queryParams: { tab: index }, queryParamsHandling: 'merge' });
  }

  private loadAll(): void {
    this.loading.set(true);
    let pending = 3;
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
  }

  saveSmtp(): void {
    this.saving.set(true);
    this.settingsService.updateSmtpConfig(this.smtp).subscribe({
      next: (c) => {
        this.smtp = { ...this.smtp, ...c };
        this.snackBar.open('SMTP config saved', 'OK', { duration: 3000 });
        this.saving.set(false);
      },
      error: (err) => {
        this.snackBar.open(err?.error?.message || 'Failed to save SMTP config', 'OK', { duration: 5000 });
        this.saving.set(false);
      },
    });
  }

  testSmtp(): void {
    this.testing.set(true);
    this.settingsService.testSmtpConfig().subscribe({
      next: (r) => {
        this.snackBar.open(r.success ? (r.message || 'Success') : (r.error || 'Test failed'), 'OK', { duration: 5000 });
        this.testing.set(false);
      },
      error: (err) => {
        this.snackBar.open(err?.error?.message || 'SMTP test failed', 'OK', { duration: 5000 });
        this.testing.set(false);
      },
    });
  }

  saveDevOps(): void {
    this.saving.set(true);
    this.settingsService.updateDevOpsConfig(this.devops).subscribe({
      next: (c) => {
        this.devops = { ...this.devops, ...c };
        this.snackBar.open('DevOps config saved', 'OK', { duration: 3000 });
        this.saving.set(false);
      },
      error: (err) => {
        this.snackBar.open(err?.error?.message || 'Failed to save DevOps config', 'OK', { duration: 5000 });
        this.saving.set(false);
      },
    });
  }

  testDevOps(): void {
    this.testing.set(true);
    this.settingsService.testDevOpsConfig().subscribe({
      next: (r) => {
        this.snackBar.open(r.success ? (r.message || 'Success') : (r.error || 'Test failed'), 'OK', { duration: 5000 });
        this.testing.set(false);
      },
      error: (err) => {
        this.snackBar.open(err?.error?.message || 'DevOps test failed', 'OK', { duration: 5000 });
        this.testing.set(false);
      },
    });
  }

  saveGithub(): void {
    this.saving.set(true);
    this.settingsService.updateGithubConfig(this.github).subscribe({
      next: (c) => {
        this.github = { ...this.github, ...c };
        this.snackBar.open('GitHub config saved', 'OK', { duration: 3000 });
        this.saving.set(false);
      },
      error: (err) => {
        this.snackBar.open(err?.error?.message || 'Failed to save GitHub config', 'OK', { duration: 5000 });
        this.saving.set(false);
      },
    });
  }

  testGithub(): void {
    this.testing.set(true);
    this.settingsService.testGithubConfig().subscribe({
      next: (r) => {
        this.snackBar.open(r.success ? (r.message || 'Success') : (r.error || 'Test failed'), 'OK', { duration: 5000 });
        this.testing.set(false);
      },
      error: (err) => {
        this.snackBar.open(err?.error?.message || 'GitHub test failed', 'OK', { duration: 5000 });
        this.testing.set(false);
      },
    });
  }
}
