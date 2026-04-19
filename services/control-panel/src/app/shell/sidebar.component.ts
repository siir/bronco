import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from '../core/services/auth.service.js';
import { ThemeService } from '../core/services/theme.service.js';
import { VersionService } from '../core/services/version.service.js';
import { TicketService } from '../core/services/ticket.service.js';
import { FailedJobsService } from '../core/services/failed-jobs.service.js';
import { APP_CONSTANTS } from '../core/config/app-constants.js';
import { NAV_ROUTES, NAV_SECTIONS, NAV_SECTION_LABELS, type NavRoute, type NavSection } from '../core/nav/nav-routes.js';
import { isScopedOpsAllowedPath } from '../core/guards/scoped-ops-allowlist.js';
import { DialogComponent } from '../shared/components/dialog.component.js';
import { IconComponent } from '../shared/components/icon.component.js';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, DialogComponent, IconComponent],
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
        @for (group of navGroups(); track group.section) {
          <div class="nav-section">
            <span class="section-label">{{ group.label }}</span>
            @for (r of group.routes; track r.route) {
              <a [routerLink]="r.route" routerLinkActive="nav-active" class="nav-item">
                {{ r.label }}
                @if (r.route === '/tickets' && ticketBadge() > 0) { <span class="badge">{{ ticketBadge() }}</span> }
                @if (r.route === '/failed-jobs' && failedJobsBadge() > 0) { <span class="badge">{{ failedJobsBadge() }}</span> }
              </a>
            }
            @if (group.section === 'account') {
              <button class="nav-item logout-btn" (click)="authService.logout()">Logout</button>
            }
          </div>
          @if (group.section === 'main' && isScoped()) {
            @if (scopedClientLink(); as clientLink) {
              <div class="nav-section">
                <span class="section-label">Client</span>
                <a [routerLink]="clientLink" routerLinkActive="nav-active" class="nav-item">Client Details</a>
              </div>
            }
          }
        }

        <button type="button" class="theme-indicator" (click)="themeDialogOpen.set(true)">
          <span class="theme-dot" [style.background]="themeService.currentTheme().accentColor"></span>
          <span>{{ themeService.currentTheme().name }}</span>
        </button>
      </div>

      <div class="sidebar-footer">
        <span class="version-label">Project {{ projectName }} {{ version() }}</span>
      </div>
    </nav>

    <app-dialog title="Theme" [open]="themeDialogOpen()" (openChange)="themeDialogOpen.set($event)" maxWidth="640px">
      <div class="theme-grid">
        @for (theme of themeService.themes; track theme.id) {
          <button
            type="button"
            class="theme-card"
            [class.theme-card-active]="theme.id === themeService.currentTheme().id"
            [attr.aria-pressed]="theme.id === themeService.currentTheme().id"
            (click)="themeService.setTheme(theme.id)">
            <div class="theme-card-preview" [class.theme-card-dark]="theme.isDark">
              <span class="theme-swatch" [style.background]="theme.accentColor"></span>
            </div>
            <div class="theme-card-info">
              <span class="theme-card-name">{{ theme.name }}</span>
              <span class="theme-card-desc">{{ theme.description }}</span>
            </div>
            @if (theme.id === themeService.currentTheme().id) {
              <span class="theme-check">
                <app-icon name="check" size="sm" />
              </span>
            }
          </button>
        }
      </div>
    </app-dialog>
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
      width: 100px;
      height: 100px;
      border-radius: var(--radius-sm);
      flex-shrink: 0;
      object-fit: cover;
    }
    .brand-text {
      display: flex;
      flex-direction: column;
    }
    .brand-name {
      font-size: 20px;
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
      background: none;
      border: none;
      font-family: var(--font-primary);
      width: 100%;
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

    /*
     * Compact-layout shell chrome tap targets.
     *
     * Under 1200px the sidebar is rendered inside a CDK Overlay drawer.
     * Nav items, the logout button, the theme-indicator link, and the
     * version label all get >= 44px hit areas so they're reliably tappable.
     */
    @media (max-width: 1199.98px) {
      .nav-item {
        padding: 12px 16px;
        font-size: 14px;
        min-height: 44px;
      }
      .logout-btn {
        padding: 12px 16px;
        font-size: 14px;
        min-height: 44px;
      }
      .theme-indicator {
        padding: 12px 16px;
        font-size: 13px;
        min-height: 44px;
      }
      .version-label {
        padding: 8px 16px 12px;
      }
    }

    .theme-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    .theme-card {
      position: relative;
      background: var(--bg-page);
      border: 2px solid var(--border-light);
      border-radius: var(--radius-md);
      padding: 0;
      cursor: pointer;
      text-align: left;
      font-family: var(--font-primary);
      overflow: hidden;
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    .theme-card:hover {
      border-color: var(--border-medium);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    }
    .theme-card-active {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .theme-card-active:hover {
      border-color: var(--accent);
    }
    .theme-card-preview {
      height: 48px;
      background: #f5f5f7;
      display: flex;
      align-items: center;
      justify-content: center;
      border-bottom: 1px solid var(--border-light);
    }
    .theme-card-preview.theme-card-dark {
      background: #1a1a1a;
    }
    .theme-swatch {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      flex-shrink: 0;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    }
    .theme-card-info {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .theme-card-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .theme-card-desc {
      font-size: 11px;
      color: var(--text-tertiary);
      line-height: 1.3;
    }
    .theme-check {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--text-on-accent);
      display: flex;
      align-items: center;
      justify-content: center;
    }
  `],
})
export class SidebarComponent {
  readonly authService = inject(AuthService);
  readonly themeService = inject(ThemeService);
  readonly themeDialogOpen = signal(false);
  private readonly versionService = inject(VersionService);
  private readonly ticketService = inject(TicketService);
  private readonly failedJobsService = inject(FailedJobsService);

  readonly projectName = APP_CONSTANTS.projectName;
  readonly version = toSignal(this.versionService.getVersion(), { initialValue: '' });
  readonly ticketBadge = this.ticketService.activeCount;
  readonly failedJobsBadge = this.failedJobsService.totalCount;

  /** True when the signed-in principal is a scoped client-side ops user. */
  readonly isScoped = computed(() => this.authService.isScopedOpsUser());

  /**
   * Deep link to the scoped user's client detail page. Returns null when the
   * clientId isn't available (shouldn't happen for a valid scoped session, but
   * we guard against it so the template can just @if on it).
   */
  readonly scopedClientLink = computed(() => {
    const user = this.authService.currentUser();
    if (!user?.clientId) return null;
    return ['/clients', user.clientId];
  });

  /** Nav sections with their routes, filtered and grouped for the current user. */
  readonly navGroups = computed(() => {
    const scoped = this.isScoped();
    // For scoped users: filter to allowed routes, excluding /dashboard which
    // auto-redirects to client detail (shown separately as Client Details).
    const routes = scoped
      ? NAV_ROUTES.filter(r => isScopedOpsAllowedPath(r.route) && r.route !== '/dashboard')
      : NAV_ROUTES;

    const grouped = new Map<NavSection, NavRoute[]>();
    for (const r of routes) {
      const bucket = grouped.get(r.section) ?? [];
      bucket.push(r);
      grouped.set(r.section, bucket);
    }

    return NAV_SECTIONS
      .filter(s => grouped.has(s))
      .map(s => ({ section: s as NavSection, label: NAV_SECTION_LABELS[s], routes: grouped.get(s)! }));
  });
}
