import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from '../core/services/auth.service';
import { VersionService } from '../core/services/version.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="sidebar">
      <div class="brand">
        <div class="brand-logo">B</div>
        <span class="brand-name">Bronco</span>
      </div>

      <div class="nav-sections">
        <div class="nav-section">
          <span class="section-label">Main</span>
          <a routerLink="/dashboard" routerLinkActive="nav-active" class="nav-item">Dashboard</a>
          <a routerLink="/tickets" routerLinkActive="nav-active" class="nav-item">Tickets</a>
          <a routerLink="/activity" routerLinkActive="nav-active" class="nav-item">Activity Feed</a>
          <a routerLink="/clients" routerLinkActive="nav-active" class="nav-item">Clients</a>
        </div>

        <div class="nav-section">
          <span class="section-label">Operations</span>
          <a routerLink="/system-status" routerLinkActive="nav-active" class="nav-item">System Status</a>
          <a routerLink="/scheduled-probes" routerLinkActive="nav-active" class="nav-item">Scheduled Probes</a>
          <a routerLink="/ingestion-jobs" routerLinkActive="nav-active" class="nav-item">Ingestion Jobs</a>
          <a routerLink="/failed-jobs" routerLinkActive="nav-active" class="nav-item">Failed Jobs</a>
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
      background: var(--accent);
      color: var(--text-on-accent);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .brand-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
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
      display: block;
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
    .version-label {
      display: block;
      padding: 2px 16px 8px;
      font-size: 11px;
      color: var(--text-tertiary);
    }
  `],
})
export class SidebarComponent {
  readonly authService = inject(AuthService);
  private readonly versionService = inject(VersionService);
  readonly version = toSignal(this.versionService.getVersion(), { initialValue: '' });
}
