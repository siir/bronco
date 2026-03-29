import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatBadgeModule } from '@angular/material/badge';
import type { Subscription } from 'rxjs';
import {
  SystemIssuesService,
  type SystemIssuesResponse,
  type FailedIssueJob,
  type OpenFinding,
  type RecentError,
} from '../../core/services/system-issues.service';

@Component({
  standalone: true,
  imports: [
    RouterLink,
    DatePipe,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatFormFieldModule,
    MatTooltipModule,
    MatBadgeModule,
  ],
  template: `
    <div class="page-header">
      <div class="title-row">
        <h1>System Issues</h1>
        @if (data(); as d) {
          <span class="issue-count" [class.clear]="d.totalIssues === 0">
            {{ d.totalIssues }} active {{ d.totalIssues === 1 ? 'issue' : 'issues' }}
          </span>
        }
      </div>
      <div class="controls">
        <mat-form-field class="window-select" subscriptSizing="dynamic">
          <mat-label>Error window</mat-label>
          <mat-select [(value)]="errorWindowDays" (selectionChange)="refresh()">
            <mat-option [value]="1">Last 24 hours</mat-option>
            <mat-option [value]="3">Last 3 days</mat-option>
            <mat-option [value]="7">Last 7 days</mat-option>
            <mat-option [value]="14">Last 14 days</mat-option>
            <mat-option [value]="30">Last 30 days</mat-option>
          </mat-select>
        </mat-form-field>
        <button mat-icon-button (click)="refresh()" [disabled]="loading()" matTooltip="Refresh">
          <mat-icon>refresh</mat-icon>
        </button>
      </div>
    </div>

    @if (loading() && !data()) {
      <div class="loading">
        <mat-spinner diameter="40"></mat-spinner>
        <span>Loading system issues...</span>
      </div>
    }

    @if (error(); as err) {
      <mat-card class="error-card">
        <mat-card-content>
          <mat-icon>error</mat-icon>
          <span>{{ err }}</span>
          <button mat-button (click)="refresh()">Retry</button>
        </mat-card-content>
      </mat-card>
    }

    @if (data(); as d) {
      @if (d.totalIssues === 0) {
        <mat-card class="clear-card">
          <mat-card-content>
            <mat-icon class="clear-icon">check_circle</mat-icon>
            <h2>All Clear</h2>
            <p>No unresolved issues from automated processes.</p>
          </mat-card-content>
        </mat-card>
      } @else {
        <!-- Failed Issue Resolution Jobs -->
        @if (d.failedIssueJobs.length > 0) {
          <section class="issue-section">
            <h2>
              <mat-icon>code_off</mat-icon>
              Failed Issue Resolution Jobs
              <span class="count-badge">{{ d.failedIssueJobs.length }}</span>
            </h2>
            <div class="card-grid">
              @for (job of d.failedIssueJobs; track job.id) {
                <mat-card class="issue-card severity-high">
                  <mat-card-header>
                    <mat-card-title>
                      <a [routerLink]="['/tickets', job.ticketId]" class="link">{{ job.ticketSubject }}</a>
                    </mat-card-title>
                    <mat-card-subtitle>{{ job.clientName }} &middot; {{ job.repoName }}</mat-card-subtitle>
                  </mat-card-header>
                  <mat-card-content>
                    @if (job.error) {
                      <div class="error-text">{{ job.error }}</div>
                    }
                    <div class="meta">
                      <span class="mono">{{ job.branchName }}</span>
                      <span class="timestamp">{{ job.failedAt | date:'short' }}</span>
                    </div>
                  </mat-card-content>
                </mat-card>
              }
            </div>
          </section>
        }

        <!-- Open Database Findings -->
        @if (d.openFindings.length > 0) {
          <section class="issue-section">
            <h2>
              <mat-icon>storage</mat-icon>
              Open Database Findings
              <span class="count-badge">{{ d.openFindings.length }}</span>
            </h2>
            <div class="card-grid">
              @for (finding of d.openFindings; track finding.id) {
                <mat-card [class]="'issue-card severity-' + finding.severity.toLowerCase()">
                  <mat-card-header>
                    <mat-card-title>{{ finding.title }}</mat-card-title>
                    <mat-card-subtitle>
                      {{ finding.clientName }} &middot; {{ finding.systemName }}
                    </mat-card-subtitle>
                  </mat-card-header>
                  <mat-card-content>
                    <div class="finding-description">{{ finding.description }}</div>
                    <div class="meta">
                      <mat-chip-set>
                        <mat-chip [class]="'severity-chip-' + finding.severity.toLowerCase()">
                          {{ finding.severity }}
                        </mat-chip>
                        <mat-chip>{{ finding.category }}</mat-chip>
                        <mat-chip>{{ finding.status }}</mat-chip>
                      </mat-chip-set>
                      <span class="timestamp">{{ finding.detectedAt | date:'short' }}</span>
                    </div>
                  </mat-card-content>
                </mat-card>
              }
            </div>
          </section>
        }

        <!-- Recent Error Logs -->
        @if (d.recentErrors.length > 0) {
          <section class="issue-section">
            <h2>
              <mat-icon>error_outline</mat-icon>
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
                  <span class="col-message" [matTooltip]="err.error ?? ''">
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
              <mat-icon>queue</mat-icon>
              Failed Queue Jobs
              <span class="count-badge">{{ failedQueues().length }}</span>
            </h2>
            <div class="card-grid">
              @for (q of failedQueues(); track q.queue) {
                <mat-card class="issue-card severity-medium">
                  <mat-card-header>
                    <mat-card-title>{{ q.queue }}</mat-card-title>
                  </mat-card-header>
                  <mat-card-content>
                    <div class="queue-failed-count">{{ q.failed }} failed {{ q.failed === 1 ? 'job' : 'jobs' }}</div>
                  </mat-card-content>
                </mat-card>
              }
            </div>
          </section>
        }
      }

      <div class="footer-meta">
        Last refreshed: {{ d.timestamp | date:'medium' }}
        @if (loading()) {
          <mat-spinner diameter="16"></mat-spinner>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .title-row {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .title-row h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 500;
    }

    .issue-count {
      background: #f44336;
      color: white;
      padding: 4px 12px;
      border-radius: 16px;
      font-size: 14px;
      font-weight: 500;
    }

    .issue-count.clear {
      background: #4caf50;
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .window-select {
      width: 160px;
    }

    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 48px;
      color: #666;
    }

    .error-card {
      background: #fff3f3;
      margin-bottom: 16px;
    }

    .error-card mat-card-content {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .error-card mat-icon {
      color: #f44336;
    }

    .clear-card {
      text-align: center;
      padding: 48px 24px;
    }

    .clear-card mat-card-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .clear-icon {
      font-size: 64px;
      width: 64px;
      height: 64px;
      color: #4caf50;
    }

    .clear-card h2 {
      margin: 0;
      color: #4caf50;
    }

    .clear-card p {
      margin: 0;
      color: #666;
    }

    .issue-section {
      margin-bottom: 32px;
    }

    .issue-section h2 {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 18px;
      font-weight: 500;
      margin: 0 0 16px 0;
      color: #333;
    }

    .issue-section h2 mat-icon {
      font-size: 22px;
      width: 22px;
      height: 22px;
      color: #666;
    }

    .count-badge {
      background: #e0e0e0;
      color: #333;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 500;
    }

    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 16px;
    }

    .issue-card {
      border-left: 4px solid #9e9e9e;
    }

    .issue-card.severity-critical {
      border-left-color: #d32f2f;
    }

    .issue-card.severity-high {
      border-left-color: #f44336;
    }

    .issue-card.severity-medium {
      border-left-color: #ff9800;
    }

    .issue-card.severity-low {
      border-left-color: #2196f3;
    }

    .issue-card mat-card-title {
      font-size: 15px;
    }

    .issue-card mat-card-subtitle {
      font-size: 13px;
    }

    .link {
      color: #3f51b5;
      text-decoration: none;
    }

    .link:hover {
      text-decoration: underline;
    }

    .error-text {
      background: #f5f5f5;
      padding: 8px 12px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 13px;
      color: #c62828;
      word-break: break-word;
      max-height: 80px;
      overflow-y: auto;
      margin-bottom: 8px;
    }

    .finding-description {
      font-size: 14px;
      color: #555;
      margin-bottom: 8px;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 13px;
      color: #888;
    }

    .mono {
      font-family: monospace;
      font-size: 12px;
      background: #f0f0f0;
      padding: 2px 6px;
      border-radius: 3px;
    }

    .timestamp {
      white-space: nowrap;
    }

    .error-table {
      background: white;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #e0e0e0;
    }

    .error-table-header {
      display: grid;
      grid-template-columns: 150px 1fr 120px;
      padding: 12px 16px;
      background: #fafafa;
      font-weight: 500;
      font-size: 13px;
      color: #666;
      border-bottom: 1px solid #e0e0e0;
    }

    .error-row {
      display: grid;
      grid-template-columns: 150px 1fr 120px;
      padding: 10px 16px;
      border-bottom: 1px solid #f0f0f0;
      font-size: 13px;
      align-items: center;
    }

    .error-row:last-child {
      border-bottom: none;
    }

    .error-row:hover {
      background: #fafafa;
    }

    .service-badge {
      background: #e8eaf6;
      color: #3f51b5;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
    }

    .col-message {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 12px;
    }

    .col-time {
      color: #888;
      text-align: right;
    }

    .queue-failed-count {
      font-size: 20px;
      font-weight: 500;
      color: #f44336;
    }

    .severity-chip-critical {
      --mdc-chip-label-text-color: #d32f2f;
    }

    .severity-chip-high {
      --mdc-chip-label-text-color: #f44336;
    }

    .severity-chip-medium {
      --mdc-chip-label-text-color: #ff9800;
    }

    .severity-chip-low {
      --mdc-chip-label-text-color: #2196f3;
    }

    .footer-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #999;
      margin-top: 16px;
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
