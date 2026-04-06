import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterOutlet, ActivatedRoute, Router, NavigationEnd } from '@angular/router';
import { SidebarComponent } from './sidebar.component';
import { HeaderBarComponent } from './header-bar.component';
import { DetailPanelComponent } from './detail-panel.component';
import { DetailPanelService } from '../core/services/detail-panel.service';
import { ThemeService } from '../core/services/theme.service';

const ROUTE_TITLE_MAP: Record<string, string> = {
  dashboard: 'Dashboard',
  clients: 'Clients',
  tickets: 'Tickets',
  prompts: 'Prompts',
  logs: 'Logs',
  'email-logs': 'Email Logs',
  'slack-conversations': 'Slack',
  'ai-usage': 'AI Usage',
  'ai-providers': 'AI Providers',
  activity: 'Activity',
  profile: 'Profile',
  'system-status': 'System Status',
  'failed-jobs': 'Failed Jobs',
  'system-issues': 'System Issues',
  'system-analysis': 'System Analysis',
  'notification-preferences': 'Notifications',
  'system-settings': 'System Settings',
  settings: 'Settings',
  'release-notes': 'Release Notes',
  'ticket-routes': 'Ticket Routes',
  'ingestion-jobs': 'Ingestion Jobs',
  'scheduled-probes': 'Scheduled Probes',
  users: 'Users',
};

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderBarComponent, DetailPanelComponent],
  template: `
    <div class="shell">
      <app-sidebar />
      <div class="shell-main">
        <app-header-bar [title]="pageTitle()" />
        <main class="shell-content">
          <router-outlet />
        </main>
      </div>
      @if (detailPanel.isOpen()) {
        <app-detail-panel />
      }
    </div>
  `,
  styles: [`
    .shell {
      display: flex;
      height: 100vh;
      background: var(--bg-page);
      color: var(--text-primary);
      overflow: hidden;
      font-family: var(--font-primary);
    }
    .shell-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .shell-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }
  `],
})
export class AppShellComponent implements OnInit {
  readonly detailPanel = inject(DetailPanelService);
  private readonly theme = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly pageTitle = signal('Dashboard');

  ngOnInit(): void {
    this.theme.init();
    const params = this.route.snapshot.queryParams;
    this.detailPanel.restoreFromUrl({
      detail: params['detail'],
      type: params['type'],
      mode: params['mode'],
    });
    this.updateTitle();
    this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) this.updateTitle();
    });
  }

  private updateTitle(): void {
    const segment = this.router.url.split('/').filter(Boolean)[0]?.split('?')[0] ?? 'dashboard';
    this.pageTitle.set(ROUTE_TITLE_MAP[segment] ?? 'Dashboard');
  }
}
