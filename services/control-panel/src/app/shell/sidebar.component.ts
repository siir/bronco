import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from '../core/services/auth.service';
import { VersionService } from '../core/services/version.service';

interface NavItem {
  label: string;
  route: string;
  icon: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-logo">B</div>
        <span class="brand-text">Bronco</span>
      </div>

      <div class="sidebar-nav">
        @for (group of navGroups; track group.label) {
          <div class="nav-group">
            <span class="nav-group-label">{{ group.label }}</span>
            @for (item of group.items; track item.route) {
              <a
                class="nav-item"
                [routerLink]="item.route"
                routerLinkActive="nav-item-active"
              >
                <span class="material-icons nav-icon">{{ item.icon }}</span>
                <span class="nav-label">{{ item.label }}</span>
              </a>
            }
          </div>
        }
      </div>

      <div class="sidebar-footer">
        <button class="nav-item logout-btn" (click)="authService.logout()">
          <span class="material-icons nav-icon">logout</span>
          <span class="nav-label">Logout</span>
        </button>
        <span class="version-label">v{{ version() }}</span>
      </div>
    </nav>
  `,
  styles: [`
    .sidebar {
      width: var(--sidebar-width);
      height: 100vh;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border-light);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      flex-shrink: 0;
    }

    .sidebar-brand {
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
      font-family: var(--font-primary);
      font-size: 15px;
      font-weight: 700;
      flex-shrink: 0;
    }

    .brand-text {
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .sidebar-nav {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px;
    }

    .nav-group {
      margin-bottom: 8px;
    }

    .nav-group-label {
      display: block;
      padding: 8px 8px 4px;
      font-family: var(--font-primary);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 400;
      color: var(--text-secondary);
      text-decoration: none;
      cursor: pointer;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      transition: background 120ms ease;
    }

    .nav-item:hover {
      background: var(--bg-hover);
    }

    .nav-item-active {
      color: var(--accent);
      background: var(--bg-active);
      font-weight: 600;
    }

    .nav-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      line-height: 18px;
      flex-shrink: 0;
    }

    .nav-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sidebar-footer {
      border-top: 1px solid var(--border-light);
      padding: 8px;
    }

    .logout-btn {
      margin-bottom: 4px;
    }

    .version-label {
      display: block;
      padding: 0 8px 4px;
      font-family: var(--font-primary);
      font-size: 11px;
      color: var(--text-tertiary);
    }
  `],
})
export class SidebarComponent {
  readonly authService = inject(AuthService);
  private readonly versionService = inject(VersionService);
  readonly version = toSignal(this.versionService.getVersion(), { initialValue: '' });

  readonly navGroups: NavGroup[] = [
    {
      label: 'Main',
      items: [
        { label: 'Dashboard', route: '/dashboard', icon: 'dashboard' },
        { label: 'Tickets', route: '/tickets', icon: 'confirmation_number' },
        { label: 'Activity Feed', route: '/activity', icon: 'dynamic_feed' },
        { label: 'Clients', route: '/clients', icon: 'business' },
      ],
    },
    {
      label: 'Operations',
      items: [
        { label: 'System Status', route: '/system-status', icon: 'monitor_heart' },
        { label: 'Scheduled Probes', route: '/scheduled-probes', icon: 'schedule_send' },
        { label: 'Ingestion Jobs', route: '/ingestion-jobs', icon: 'dynamic_feed' },
        { label: 'Failed Jobs', route: '/failed-jobs', icon: 'error_outline' },
        { label: 'Logs', route: '/logs', icon: 'article' },
        { label: 'Email Log', route: '/email-logs', icon: 'email' },
      ],
    },
    {
      label: 'AI',
      items: [
        { label: 'AI Prompts', route: '/prompts', icon: 'smart_toy' },
        { label: 'AI Providers', route: '/ai-providers', icon: 'hub' },
        { label: 'AI Usage', route: '/ai-usage', icon: 'analytics' },
        { label: 'Ticket Routes', route: '/ticket-routes', icon: 'route' },
        { label: 'System Analysis', route: '/system-analysis', icon: 'insights' },
        { label: 'System Issues', route: '/system-issues', icon: 'report_problem' },
      ],
    },
    {
      label: 'Integrations',
      items: [
        { label: 'Slack Conversations', route: '/slack-conversations', icon: 'chat' },
        { label: 'Release Notes', route: '/release-notes', icon: 'new_releases' },
      ],
    },
    {
      label: 'Account',
      items: [
        { label: 'Profile', route: '/profile', icon: 'person' },
        { label: 'Notifications', route: '/notification-preferences', icon: 'notifications' },
        { label: 'User Maint', route: '/users', icon: 'group' },
        { label: 'System Settings', route: '/system-settings', icon: 'tune' },
        { label: 'Settings', route: '/settings', icon: 'settings' },
      ],
    },
  ];
}
