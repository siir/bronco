import { Component, DestroyRef, effect, inject, OnInit, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet, ActivatedRoute, Router, NavigationEnd } from '@angular/router';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { ESCAPE } from '@angular/cdk/keycodes';
import { SidebarComponent } from './sidebar.component';
import { SidebarDrawerComponent } from './sidebar-drawer.component';
import { HeaderBarComponent } from './header-bar.component';
import { DetailPanelComponent } from './detail-panel.component';
import { DetailPanelService } from '../core/services/detail-panel.service';
import { ThemeService } from '../core/services/theme.service';
import { ViewportService } from '../core/services/viewport.service';
import { SidebarService } from '../core/services/sidebar.service';
import { ToastContainerComponent } from '../shared/components/toast-container.component';

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
  detail: 'Details',
};

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderBarComponent, DetailPanelComponent, ToastContainerComponent],
  template: `
    <div class="shell">
      @if (!viewport.isMobile()) {
        <app-sidebar />
      }
      <div class="shell-main">
        <app-header-bar [title]="pageTitle()" />
        <main class="shell-content">
          <router-outlet />
        </main>
      </div>
      @if (!viewport.isMobile() && detailPanel.isOpen() && !onDetailRoute()) {
        <app-detail-panel />
      }
    </div>
    <app-toast-container />
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
    @media (max-width: 767.98px) {
      .shell-content {
        padding: 12px;
      }
    }
  `],
})
export class AppShellComponent implements OnInit {
  readonly detailPanel = inject(DetailPanelService);
  readonly viewport = inject(ViewportService);
  private readonly sidebar = inject(SidebarService);
  private readonly theme = inject(ThemeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly overlay = inject(Overlay);
  private readonly destroyRef = inject(DestroyRef);
  readonly pageTitle = signal('Dashboard');
  readonly onDetailRoute = signal(false);

  private drawerRef: OverlayRef | null = null;

  constructor() {
    // Drawer open/close ↔ CDK Overlay attach/detach.
    effect(() => {
      const open = this.sidebar.isOpen();
      const mobile = this.viewport.isMobile();
      untracked(() => {
        if (open && mobile) {
          this.openDrawer();
        } else {
          this.closeDrawer();
        }
      });
    });

    // Desktop → mobile flip with a side pane open: clear state so the URL
    // doesn't keep stale ?detail= query params and the hidden pane state
    // doesn't reappear on resize back to desktop mid-session. Mobile →
    // desktop is intentionally unhandled (the routed /detail view remains).
    effect(() => {
      const mobile = this.viewport.isMobile();
      untracked(() => {
        if (mobile && this.detailPanel.isOpen() && !this.router.url.startsWith('/detail/')) {
          this.detailPanel.close();
        }
      });
    });
  }

  ngOnInit(): void {
    this.theme.init();
    const params = this.route.snapshot.queryParams;
    this.detailPanel.restoreFromUrl({
      detail: params['detail'],
      type: params['type'],
      mode: params['mode'],
    });
    this.updateTitle();
    this.router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (event instanceof NavigationEnd) this.updateTitle();
    });
  }

  private updateTitle(): void {
    const segment = this.router.url.split('/').filter(Boolean)[0]?.split('?')[0] ?? 'dashboard';
    this.pageTitle.set(ROUTE_TITLE_MAP[segment] ?? 'Dashboard');
    this.onDetailRoute.set(this.router.url.startsWith('/detail/'));
  }

  private openDrawer(): void {
    if (this.drawerRef) return;
    this.drawerRef = this.overlay.create({
      hasBackdrop: true,
      backdropClass: 'sidebar-drawer-backdrop',
      panelClass: 'sidebar-drawer-pane',
      positionStrategy: this.overlay.position()
        .global()
        .left('0')
        .top('0'),
      height: '100%',
      disposeOnNavigation: false,
      scrollStrategy: this.overlay.scrollStrategies.block(),
    });
    this.drawerRef.backdropClick().subscribe(() => this.sidebar.close());
    this.drawerRef.keydownEvents().subscribe(e => {
      if (e.keyCode === ESCAPE) {
        e.preventDefault();
        this.sidebar.close();
      }
    });
    this.drawerRef.attach(new ComponentPortal(SidebarDrawerComponent));
  }

  private closeDrawer(): void {
    if (!this.drawerRef) return;
    this.drawerRef.dispose();
    this.drawerRef = null;
  }
}
