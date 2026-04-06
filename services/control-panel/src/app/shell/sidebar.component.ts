import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from '../core/services/auth.service';
import { ThemeService } from '../core/services/theme.service';
import { VersionService } from '../core/services/version.service';
import { TicketService, ACTIVE_STATUS_FILTER } from '../core/services/ticket.service';
import { FailedJobsService } from '../core/services/failed-jobs.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="sidebar">
      <div class="brand">
        <img class="brand-logo" src="logo.png" alt="Bronco">
        <div class="brand-text">
          <span class="brand-name">iTrack 3</span>
          <span class="brand-subtitle">with iTrackAI®</span>
        </div>
      </div>

      <div class="nav-sections">
        <div class="nav-section">
          <span class="section-label">Main</span>
          <a routerLink="/dashboard" routerLinkActive="nav-active" class="nav-item">Dashboard</a>
          <a routerLink="/tickets" routerLinkActive="nav-active" class="nav-item">Tickets @if (ticketBadge() > 0) { <span class="badge">{{ ticketBadge() }}</span> }</a>
          <a routerLink="/activity" routerLinkActive="nav-active" class="nav-item">Activity Feed</a>
          <a routerLink="/clients" routerLinkActive="nav-active" class="nav-item">Clients</a>
        </div>

        <div class="nav-section">
          <span class="section-label">Operations</span>
          <a routerLink="/system-status" routerLinkActive="nav-active" class="nav-item">System Status</a>
          <a routerLink="/scheduled-probes" routerLinkActive="nav-active" class="nav-item">Scheduled Probes</a>
          <a routerLink="/ingestion-jobs" routerLinkActive="nav-active" class="nav-item">Ingestion Jobs</a>
          <a routerLink="/failed-jobs" routerLinkActive="nav-active" class="nav-item">Failed Jobs @if (failedJobsBadge() > 0) { <span class="badge">{{ failedJobsBadge() }}</span> }</a>
          <a routerLink="/logs" routerLinkActive="nav-active" class="nav-item">Logs</a>
          <a routerLink="/email-logs" routerLinkActive="nav-active" class="nav-item">Email Log</a>
        </div>

        <div class="nav-section">
          <span class="section-label">AI</span>
          <a routerLink="/prompts" routerLinkActive="nav-active" class="nav-item">AI Prompts</a>
          <a routerLink="/ai-providers" routerLinkActive="nav-active" class="nav-item">AI Providers</a>
          <a routerLink="/ai-usage" routerLinkActive="nav-active" class="nav-item">AI Usage</a>
          <a routerLink="/ticket-routes" routerLinkActive="nav-active" class="nav-item">Ticket Routes</a>
          <a routerLink="/system-analysis" routerLinkActive="nav-active" class="nav-item">System Analysis</a>
          <a routerLink="/system-issues" routerLinkActive="nav-active" class="nav-item">System Issues</a>
        </div>

        <div class="nav-section">
          <span class="section-label">Integrations</span>
          <a routerLink="/slack-conversations" routerLinkActive="nav-active" class="nav-item">Slack Conversations</a>
          <a routerLink="/release-notes" routerLinkActive="nav-active" class="nav-item">Release Notes</a>
        </div>

        <div class="nav-section">
          <span class="section-label">Account</span>
          <a routerLink="/profile" routerLinkActive="nav-active" class="nav-item">Profile</a>
          <a routerLink="/notification-preferences" routerLinkActive="nav-active" class="nav-item">Notifications</a>
          <a routerLink="/users" routerLinkActive="nav-active" class="nav-item">User Maint</a>
          <a routerLink="/system-settings" routerLinkActive="nav-active" class="nav-item">System Settings</a>
          <a routerLink="/settings" routerLinkActive="nav-active" class="nav-item">Settings</a>
        </div>
      </div>

      <div class="sidebar-footer">
        <button class="nav-item logout-btn" (click)="authService.logout()">Logout</button>
        <a routerLink="/profile" class="theme-indicator">
          <span class="theme-dot" [style.background]="themeService.currentTheme().accentColor"></span>
          <span>{{ themeService.currentTheme().name }}</span>
        </a>
        <span class="version-label">v{{ version() }}</span>
      </div>
    </nav>
  `,
  styles: [`
    .sidebar {
      width: var(--sidebar-width);
      min-width: var(--sidebar-width);
      height: 100vh;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border-light);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      font-family: var(--font-primary);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px 16px 12px;
    }
    .brand-logo {
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      flex-shrink: 0;
      object-fit: cover;
    }
    .brand-text {
      display: flex;
      flex-direction: column;
    }
    .brand-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.2;
    }
    .brand-subtitle {
      font-size: 10px;
      font-weight: 400;
      color: var(--text-tertiary);
      line-height: 1.2;
    }
    .nav-sections {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    .nav-section {
      padding: 4px 0;
    }
    .section-label {
      display: block;
      padding: 8px 16px 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
    }
    .nav-item {
      display: flex;
      align-items: center;
      padding: 6px 16px;
      font-size: 13px;
      font-weight: 400;
      color: var(--text-secondary);
      text-decoration: none;
      border-radius: var(--radius-sm);
      margin: 1px 8px;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease;
    }
    .nav-item:hover {
      background: var(--bg-hover);
    }
    .nav-active {
      color: var(--accent);
      background: var(--bg-active);
      font-weight: 600;
    }
    .sidebar-footer {
      margin-top: auto;
      border-top: 1px solid var(--border-light);
      padding: 8px 0 4px;
    }
    .logout-btn {
      width: calc(100% - 16px);
      text-align: left;
      background: none;
      border: none;
      font-family: var(--font-primary);
    }
    .theme-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 16px;
      font-size: 12px;
      color: var(--text-tertiary);
      text-decoration: none;
      cursor: pointer;
      transition: color 120ms ease;
    }
    .theme-indicator:hover {
      color: var(--text-secondary);
    }
    .theme-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .version-label {
      display: block;
      padding: 2px 16px 8px;
      font-size: 11px;
      color: var(--text-tertiary);
    }
    .badge {
      margin-left: auto;
      background: var(--accent);
      color: var(--text-on-accent);
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: var(--radius-pill);
      min-width: 18px;
      text-align: center;
    }
  `],
})
export class SidebarComponent implements OnInit {
  readonly authService = inject(AuthService);
  readonly themeService = inject(ThemeService);
  private readonly versionService = inject(VersionService);
  private readonly ticketService = inject(TicketService);
  private readonly failedJobsService = inject(FailedJobsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly version = toSignal(this.versionService.getVersion(), { initialValue: '' });
  readonly ticketBadge = signal(0);
  readonly failedJobsBadge = signal(0);

  ngOnInit(): void {
    const activeStatuses = ACTIVE_STATUS_FILTER.split(',');

    this.ticketService.getStats()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(stats => {
        const count = activeStatuses.reduce((sum, s) => sum + (stats.byStatus[s] ?? 0), 0);
        this.ticketBadge.set(count);
      });

    this.failedJobsService.list({ limit: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(res => {
        this.failedJobsBadge.set(res.total);
      });
  }
}
