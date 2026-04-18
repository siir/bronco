import { Component, DestroyRef, effect, HostListener, inject, OnInit, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { SidebarComponent } from './sidebar.component.js';
import { SidebarDrawerComponent } from './sidebar-drawer.component.js';
import { HeaderBarComponent } from './header-bar.component.js';
import { DetailPanelComponent } from './detail-panel.component.js';
import { DetailPanelService } from '../core/services/detail-panel.service.js';
import { ThemeService } from '../core/services/theme.service.js';
import { ViewportService } from '../core/services/viewport.service.js';
import { SidebarService } from '../core/services/sidebar.service.js';
import { AuthService } from '../core/services/auth.service.js';
import { TicketService } from '../core/services/ticket.service.js';
import { FailedJobsService } from '../core/services/failed-jobs.service.js';
import { CommandPaletteComponent } from '../shared/components/command-palette.component.js';
import { CommandPaletteService } from '../core/services/command-palette.service.js';

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
  imports: [RouterOutlet, SidebarComponent, HeaderBarComponent, DetailPanelComponent, CommandPaletteComponent],
  template: `
    <div class="shell">
      @if (!viewport.isCompactLayout()) {
        <app-sidebar />
      }
      <div class="shell-main">
        <app-header-bar [title]="pageTitle()" />
        <main class="shell-content">
          <router-outlet />
        </main>
      </div>
      @if (!viewport.isCompactLayout() && detailPanel.isOpen() && !onDetailRoute()) {
        <app-detail-panel />
      }
    </div>
    <app-command-palette />
  `,
  styles: [`
    .shell {
      display: flex;
      height: 100vh;
      background: var(--bg-page);
      color: var(--text-primary);
      overflow: hidden;
      font-family: var(--font-primary);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
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
        padding-bottom: max(12px, env(safe-area-inset-bottom));
      }
    }
  `],
})
export class AppShellComponent implements OnInit {
  readonly detailPanel = inject(DetailPanelService);
  readonly viewport = inject(ViewportService);
  readonly paletteService = inject(CommandPaletteService);
  private readonly sidebar = inject(SidebarService);
  private readonly theme = inject(ThemeService);
  private readonly auth = inject(AuthService);
  private readonly ticketService = inject(TicketService);
  private readonly failedJobsService = inject(FailedJobsService);
  private readonly router = inject(Router);
  private readonly overlay = inject(Overlay);
  private readonly destroyRef = inject(DestroyRef);
  readonly pageTitle = signal('Dashboard');
  readonly onDetailRoute = signal(false);

  private drawerRef: OverlayRef | null = null;

  /**
   * Global ⌘K / Ctrl+K handler — opens the command palette.
   */
  @HostListener('document:keydown', ['$event'])
  private onDocumentKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      this.paletteService.open();
    }
  }

  /**
   * Global Escape handler for the sidebar drawer.
   *
   * We use @HostListener (document-level keydown via Angular's EventManager)
   * rather than `drawerRef.keydownEvents()` because the overlay stream only
   * fires when focus is inside the overlay. Document-level is robust across
   * focus-loss scenarios.
   */
  @HostListener('document:keydown.escape', ['$event'])
  private onDocumentEscape(e: KeyboardEvent): void {
    // Precedence: drawer → side pane → no-op. Close whatever's "on top".
    if (this.drawerRef) {
      e.preventDefault();
      this.sidebar.close();
      return;
    }
    if (this.detailPanel.isOpen()) {
      e.preventDefault();
      this.detailPanel.close();
    }
  }

  constructor() {
    // Drawer open/close ↔ CDK Overlay attach/detach.
    effect(() => {
      const open = this.sidebar.isOpen();
      const compact = this.viewport.isCompactLayout();
      untracked(() => {
        if (open && compact) {
          this.openDrawer();
        } else {
          this.closeDrawer();
          if (open && !compact) this.sidebar.close();
        }
      });
    });

    // Viewport flip: keep the pane visible across the compact-layout boundary
    // (1200px) by swapping presentations, not by destroying state.
    //   Desktop → compact: side pane open on /dashboard?detail=… →
    //     navigate to /detail/:type/:id (routed takeover view).
    //   Compact → desktop: routed view at /detail/:type/:id →
    //     navigate to parent list with ?detail=…&type=…&mode=… query
    //     params so the inline side pane renders.
    // For the compact→desktop direction, DetailViewComponent.ngOnDestroy
    // would otherwise dismiss the signals mid-transition and blank the
    // pane; we suppress that one dismiss so the inline pane picks up
    // the existing state.
    effect(() => {
      const compact = this.viewport.isCompactLayout();
      untracked(() => {
        const onDetailRoute = this.router.url.startsWith('/detail/');
        const type = this.detailPanel.entityType();
        const id = this.detailPanel.entityId();
        const mode = this.detailPanel.mode();

        if (compact && this.detailPanel.isOpen() && !onDetailRoute) {
          // Desktop → compact with side pane active.
          if (!type || !id) return;
          this.router.navigate(['/detail', type, id], {
            queryParams: mode === 'full' ? undefined : { mode },
          });
          return;
        }

        if (!compact && onDetailRoute) {
          // Compact → desktop on routed view: restore parent list + pane.
          if (!type || !id) return;
          const parent = DetailPanelService.PARENT_LIST[type] ?? '/dashboard';
          this.detailPanel.suppressNextDismiss();
          this.router.navigate([parent], {
            queryParams: { detail: id, type, mode },
            queryParamsHandling: 'merge',
          });
        }
      });
    });
  }

  ngOnInit(): void {
    this.theme.init();
    // Read query params directly from window.location, not the router.
    // AppShellComponent is mounted via app.component.ts's
    // `@if (currentUser())` conditional, which flips true as soon as
    // auth init completes. At that moment Angular's router hasn't yet
    // finished processing the initial URL, so `router.url` is still '/'
    // and `ActivatedRoute.snapshot.queryParams` is empty even though the
    // browser URL (`window.location`) holds the real query string. Parse
    // window.location directly to restore pane state reliably — this is
    // the source of truth.
    const urlParams = new URLSearchParams(window.location.search);
    this.detailPanel.restoreFromUrl({
      detail: urlParams.get('detail') ?? undefined,
      type: urlParams.get('type') ?? undefined,
      mode: urlParams.get('mode') ?? undefined,
    });
    this.updateTitle();
    this.router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (!(event instanceof NavigationEnd)) return;
      this.updateTitle();
      // Re-sync pane state from the URL on every navigation. Without this,
      // the signals persist across routerLink navigations (routerLink drops
      // query params by default), so clicking a sidebar link while a pane
      // is open would leave the pane stuck on the new page. Anchor the
      // pane to the URL so it cleanly appears/disappears with nav.
      //
      // Skip when landing on a /detail/:type/:id route — DetailViewComponent
      // owns signal hydration there via hydrateFromParams, and we don't
      // want to race with it.
      const url = event.urlAfterRedirects;
      if (url.startsWith('/detail/')) return;
      // Use the router's own parser so query extraction is fragment-safe
      // (a naive `url.split('?')[1]` would absorb a trailing `#fragment`
      // into the last query value).
      const tree = this.router.parseUrl(url);
      this.detailPanel.restoreFromUrl({
        detail: tree.queryParamMap.get('detail') ?? undefined,
        type: tree.queryParamMap.get('type') ?? undefined,
        mode: tree.queryParamMap.get('mode') ?? undefined,
      });
    });

    // Seed sidebar badges here (not in SidebarComponent). The shell always
    // mounts at app boot; the sidebar only mounts inline on desktop and
    // lazily-inside-the-drawer on mobile, so scoping the fetch to the
    // sidebar would miss the mobile boot case and leave badges at 0 until
    // the user opens the drawer. Scoped ops users lack permission for both
    // global stats and the failed-jobs queue — they would 403.
    if (!this.auth.isScopedOpsUser()) {
      this.ticketService.getStats()
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
      this.failedJobsService.list({ limit: 1 })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
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
    this.drawerRef.attach(new ComponentPortal(SidebarDrawerComponent));
  }

  private closeDrawer(): void {
    if (!this.drawerRef) return;
    this.drawerRef.dispose();
    this.drawerRef = null;
  }
}
