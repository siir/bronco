import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { Subscription } from 'rxjs';
import {
  SystemIssuesService,
  type SystemIssuesResponse,
  type FailedIssueJob,
  type OpenFinding,
  type RecentError,
} from '../../core/services/system-issues.service';
import { BroncoButtonComponent, SelectComponent } from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [
    RouterLink,
    DatePipe,
    FormsModule,
    BroncoButtonComponent,
    SelectComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <div class="title-row">
          <h1 class="page-title">System Issues</h1>
          @if (data(); as d) {
            <span class="issue-count" [class.clear]="d.totalIssues === 0">
              {{ d.totalIssues }} active {{ d.totalIssues === 1 ? 'issue' : 'issues' }}
            </span>
          }
        </div>
        <div class="controls">
          <app-select
            [value]="errorWindowDays.toString()"
            [options]="windowOptions"
            [placeholder]="''"
            (valueChange)="errorWindowDays = +$event; refresh()">
          </app-select>
          <app-bronco-button variant="icon" size="sm" (click)="refresh()" [disabled]="loading()" title="Refresh">
            ↻
          </app-bronco-button>
        </div>
      </div>

      @if (loading() && !data()) {
        <div class="loading">
          <div class="loading-spinner" aria-hidden="true"></div>
          <span>Loading system issues...</span>
        </div>
      }

      @if (error(); as err) {
        <div class="card error-card">
          <span class="error-icon">⚠</span>
          <span>{{ err }}</span>
          <app-bronco-button variant="ghost" (click)="refresh()">Retry</app-bronco-button>
        </div>
      }

      @if (data(); as d) {
        @if (d.totalIssues === 0) {
          <div class="card clear-card">
            <span class="clear-icon">✓</span>
            <h2>All Clear</h2>
            <p>No unresolved issues from automated processes.</p>
          </div>
        } @else {
          <!-- Failed Issue Resolution Jobs -->
          @if (d.failedIssueJobs.length > 0) {
            <section class="issue-section">
              <h2>
                Failed Issue Resolution Jobs
                <span class="count-badge">{{ d.failedIssueJobs.length }}</span>
              </h2>
              <div class="card-grid">
                @for (job of d.failedIssueJobs; track job.id) {
                  <div class="card issue-card severity-high">
                    <div class="card-title">
                      <a [routerLink]="['/tickets', job.ticketId]" class="link">{{ job.ticketSubject }}</a>
                    </div>
                    <div class="card-subtitle">{{ job.clientName }} &middot; {{ job.repoName }}</div>
                    @if (job.error) {
                      <div class="error-text">{{ job.error }}</div>
                    }
                    <div class="meta">
                      <span class="mono">{{ job.branchName }}</span>
                      <span class="timestamp">{{ job.failedAt | date:'short' }}</span>
                    </div>
                  </div>
                }
              </div>
            </section>
          }

          <!-- Open Database Findings -->
          @if (d.openFindings.length > 0) {
            <section class="issue-section">
              <h2>
                Open Database Findings
                <span class="count-badge">{{ d.openFindings.length }}</span>
              </h2>
              <div class="card-grid">
                @for (finding of d.openFindings; track finding.id) {
                  <div [class]="'card issue-card severity-' + finding.severity.toLowerCase()">
                    <div class="card-title">{{ finding.title }}</div>
                    <div class="card-subtitle">
                      {{ finding.clientName }} &middot; {{ finding.systemName }}
                    </div>
                    <div class="finding-description">{{ finding.description }}</div>
                    <div class="meta">
                      <div class="chip-set">
                        <span [class]="'chip severity-chip-' + finding.severity.toLowerCase()">{{ finding.severity }}</span>
                        <span class="chip">{{ finding.category }}</span>
                        <span class="chip">{{ finding.status }}</span>
                      </div>
                      <span class="timestamp">{{ finding.detectedAt | date:'short' }}</span>
                    </div>
                  </div>
                }
              </div>
            </section>
          }

          <!-- Recent Error Logs -->
          @if (d.recentErrors.length > 0) {
            <section class="issue-section">
              <h2>
                Unresolved Error Logs
                <span class="count-badge">{{ d.recentErrors.length }}</span>
              </h2>
              <div class="error-table">
                <div class="error-table-header">
                  <span class="col-service">Service</span>
                  <span class="col-message">Message</span>
                  <span class="col-time">Time</span>
                </div>
                @for (err of d.recentErrors; track err.id) {
                  <div class="error-row">
                    <span class="col-service">
                      <span class="service-badge">{{ err.service }}</span>
                    </span>
                    <span class="col-message" [title]="err.error ?? ''">
                      {{ err.message }}
                    </span>
                    <span class="col-time">{{ err.createdAt | date:'short' }}</span>
                  </div>
                }
              </div>
            </section>
          }

          <!-- Failed Queue Jobs -->
          @if (failedQueues().length > 0) {
            <section class="issue-section">
              <h2>
                Failed Queue Jobs
                <span class="count-badge">{{ failedQueues().length }}</span>
              </h2>
              <div class="card-grid">
                @for (q of failedQueues(); track q.queue) {
                  <div class="card issue-card severity-medium">
                    <div class="card-title">{{ q.queue }}</div>
                    <div class="queue-failed-count">{{ q.failed }} failed {{ q.failed === 1 ? 'job' : 'jobs' }}</div>
                  </div>
                }
              </div>
            </section>
          }
        }

        <div class="footer-meta">
          Last refreshed: {{ d.timestamp | date:'medium' }}
          @if (loading()) {
            <span class="refresh-spinner" aria-hidden="true"></span>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .page-wrapper { max-width: 1200px; }
    .page-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 24px; flex-wrap: wrap; gap: 12px;
    }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .title-row { display: flex; align-items: center; gap: 16px; }
    .issue-count {
      background: var(--color-error); color: var(--text-on-accent);
      padding: 4px 12px; border-radius: var(--radius-pill);
      font-family: var(--font-primary); font-size: 14px; font-weight: 500;
    }
    .issue-count.clear { background: var(--color-success); }
    .controls { display: flex; align-items: center; gap: 8px; }
    .controls app-select { width: 160px; }

    .loading {
      display: flex; align-items: center; justify-content: center; gap: 16px;
      padding: 48px; color: var(--text-tertiary); font-family: var(--font-primary);
    }
    .loading-spinner {
      width: 24px; height: 24px; border: 3px solid var(--border-light);
      border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

    .card {
      background: var(--bg-card); border-radius: var(--radius-lg);
      padding: 16px; box-shadow: var(--shadow-card);
    }
    .error-card {
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 16px; background: rgba(255, 59, 48, 0.04);
    }
    .error-icon { color: var(--color-error); font-size: 18px; }

    .clear-card {
      text-align: center; padding: 48px 24px;
      display: flex; flex-direction: column; align-items: center; gap: 8px;
    }
    .clear-icon {
      font-size: 48px; width: 64px; height: 64px; display: flex; align-items: center;
      justify-content: center; color: var(--color-success);
      background: rgba(52, 199, 89, 0.08); border-radius: 50%;
    }
    .clear-card h2 { margin: 0; font-family: var(--font-primary); color: var(--color-success); }
    .clear-card p { margin: 0; font-family: var(--font-primary); color: var(--text-tertiary); }

    .issue-section { margin-bottom: 32px; }
    .issue-section h2 {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--font-primary); font-size: 18px; font-weight: 500;
      margin: 0 0 16px 0; color: var(--text-primary);
    }
    .count-badge {
      background: var(--bg-muted); color: var(--text-secondary);
      padding: 2px 10px; border-radius: var(--radius-pill);
      font-family: var(--font-primary); font-size: 13px; font-weight: 500;
    }
    .card-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px;
    }
    .issue-card { border-left: 4px solid var(--text-tertiary); }
    .issue-card.severity-critical { border-left-color: var(--color-error); }
    .issue-card.severity-high { border-left-color: var(--color-error); }
    .issue-card.severity-medium { border-left-color: var(--color-warning); }
    .issue-card.severity-low { border-left-color: var(--color-info); }

    .card-title { font-family: var(--font-primary); font-size: 15px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px; }
    .card-subtitle { font-family: var(--font-primary); font-size: 13px; color: var(--text-tertiary); margin-bottom: 8px; }
    .link { color: var(--accent-link); text-decoration: none; }
    .link:hover { text-decoration: underline; }

    .error-text {
      background: var(--bg-muted); padding: 8px 12px; border-radius: var(--radius-sm);
      font-family: monospace; font-size: 13px; color: var(--color-error);
      word-break: break-word; max-height: 80px; overflow-y: auto; margin-bottom: 8px;
    }
    .finding-description {
      font-family: var(--font-primary); font-size: 14px; color: var(--text-tertiary);
      margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 3;
      -webkit-box-orient: vertical; overflow: hidden;
    }
    .meta {
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 8px; font-size: 13px; color: var(--text-tertiary);
    }
    .mono {
      font-family: monospace; font-size: 12px; background: var(--bg-muted);
      padding: 2px 6px; border-radius: var(--radius-sm);
    }
    .timestamp { white-space: nowrap; }

    .chip-set { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip {
      font-family: var(--font-primary); font-size: 11px; font-weight: 500;
      padding: 2px 8px; border-radius: var(--radius-pill); background: var(--bg-muted);
      color: var(--text-secondary);
    }
    .severity-chip-critical { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }
    .severity-chip-high { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }
    .severity-chip-medium { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .severity-chip-low { background: rgba(0, 122, 255, 0.1); color: var(--color-info); }

    .error-table {
      background: var(--bg-card); border-radius: var(--radius-lg);
      overflow: hidden; border: 1px solid var(--border-light); box-shadow: var(--shadow-card);
    }
    .error-table-header {
      display: grid; grid-template-columns: 150px 1fr 120px;
      padding: 12px 16px; background: var(--bg-muted);
      font-family: var(--font-primary); font-weight: 500; font-size: 13px;
      color: var(--text-tertiary); border-bottom: 1px solid var(--border-light);
    }
    .error-row {
      display: grid; grid-template-columns: 150px 1fr 120px;
      padding: 10px 16px; border-bottom: 1px solid var(--border-light);
      font-family: var(--font-primary); font-size: 13px; align-items: center;
    }
    .error-row:last-child { border-bottom: none; }
    .error-row:hover { background: var(--bg-hover); }
    .service-badge {
      background: var(--color-info-subtle); color: var(--accent);
      padding: 2px 8px; border-radius: var(--radius-sm);
      font-size: 12px; font-family: monospace;
    }
    .col-message {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding-right: 12px; color: var(--text-secondary);
    }
    .col-time { color: var(--text-tertiary); text-align: right; }

    .queue-failed-count {
      font-family: var(--font-primary); font-size: 20px;
      font-weight: 500; color: var(--color-error);
    }

    .footer-meta {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--font-primary); font-size: 12px;
      color: var(--text-tertiary); margin-top: 16px;
    }
    .refresh-spinner {
      width: 16px; height: 16px; border: 2px solid var(--border-light);
      border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
      display: inline-block;
    }
  `],
})
export class SystemIssuesComponent implements OnInit, OnDestroy {
  private issuesService = inject(SystemIssuesService);
  private refreshInterval: ReturnType<typeof setInterval> | undefined;
  private refreshSub: Subscription | undefined;

  data = signal<SystemIssuesResponse | null>(null);
  loading = signal(false);
  error = signal<string | null>(null);
  errorWindowDays = 7;

  windowOptions = [
    { value: '1', label: 'Last 24 hours' },
    { value: '3', label: 'Last 3 days' },
    { value: '7', label: 'Last 7 days' },
    { value: '14', label: 'Last 14 days' },
    { value: '30', label: 'Last 30 days' },
  ];

  failedQueues = computed(() => {
    const d = this.data();
    if (!d) return [];
    return d.failedQueues.filter(q => q.failed > 0);
  });

  ngOnInit() {
    this.refresh();
    this.refreshInterval = setInterval(() => this.refresh(), 60_000);
  }

  ngOnDestroy() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshSub?.unsubscribe();
  }

  refresh() {
    this.refreshSub?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);

    this.refreshSub = this.issuesService.getIssues(this.errorWindowDays).subscribe({
      next: (response) => {
        this.data.set(response);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message ?? err.error?.error ?? err.message ?? 'Failed to load system issues');
        this.loading.set(false);
      },
    });
  }
}
