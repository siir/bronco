import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { AppSwitcherComponent } from '@bronco/shared-ui';
import { AuthService } from './core/services/auth.service';
import { VersionService } from './core/services/version.service';

const MOBILE_BREAKPOINT = '(max-width: 767px)';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatToolbarModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    AppSwitcherComponent,
  ],
  template: `
    @if (authService.currentUser()) {
      <mat-sidenav-container class="app-container">
        <mat-sidenav
          [mode]="isMobile() ? 'over' : 'side'"
          [opened]="!isMobile() || mobileSidenavOpen()"
          (openedChange)="onSidenavOpenedChange($event)"
          class="sidenav"
        >
          <div class="sidenav-header">
            <img src="logo.svg" alt="" aria-hidden="true" class="logo">
            <div class="header-text">
              <h2>Bronco</h2>
              <rc-app-switcher currentApp="Control Panel" />
            </div>
          </div>
          <mat-nav-list>
            <a mat-list-item routerLink="/dashboard" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>dashboard</mat-icon>
              <span matListItemTitle>Dashboard</span>
            </a>
            <a mat-list-item routerLink="/tickets" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>confirmation_number</mat-icon>
              <span matListItemTitle>Tickets</span>
            </a>
            <a mat-list-item routerLink="/activity" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>dynamic_feed</mat-icon>
              <span matListItemTitle>Activity Feed</span>
            </a>
            <a mat-list-item routerLink="/release-notes" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>new_releases</mat-icon>
              <span matListItemTitle>Release Notes</span>
            </a>
            <a mat-list-item routerLink="/system-status" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>monitor_heart</mat-icon>
              <span matListItemTitle>System Status</span>
            </a>
            <a mat-list-item routerLink="/failed-jobs" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>error_outline</mat-icon>
              <span matListItemTitle>Failed Jobs</span>
            </a>
            <a mat-list-item routerLink="/system-analysis" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>insights</mat-icon>
              <span matListItemTitle>System Analysis</span>
            </a>
            <a mat-list-item routerLink="/system-issues" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>report_problem</mat-icon>
              <span matListItemTitle>System Issues</span>
            </a>
            <a mat-list-item routerLink="/ai-usage" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>analytics</mat-icon>
              <span matListItemTitle>AI Usage</span>
            </a>
            <a mat-list-item routerLink="/prompts" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>smart_toy</mat-icon>
              <span matListItemTitle>AI Prompts</span>
            </a>
            <a mat-list-item routerLink="/ai-providers" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>hub</mat-icon>
              <span matListItemTitle>AI Providers</span>
            </a>
            <a mat-list-item routerLink="/ticket-routes" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>route</mat-icon>
              <span matListItemTitle>Ticket Routes</span>
            </a>
            <a mat-list-item routerLink="/ingestion-jobs" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>dynamic_feed</mat-icon>
              <span matListItemTitle>Ingestion Jobs</span>
            </a>
            <a mat-list-item routerLink="/scheduled-probes" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>schedule_send</mat-icon>
              <span matListItemTitle>Scheduled Probes</span>
            </a>
            <a mat-list-item routerLink="/logs" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>article</mat-icon>
              <span matListItemTitle>Logs</span>
            </a>
            <a mat-list-item routerLink="/email-logs" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>email</mat-icon>
              <span matListItemTitle>Email Log</span>
            </a>
            <a mat-list-item routerLink="/clients" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>business</mat-icon>
              <span matListItemTitle>Clients</span>
            </a>
            <a mat-list-item routerLink="/users" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>group</mat-icon>
              <span matListItemTitle>User Maint</span>
            </a>
            <a mat-list-item routerLink="/profile" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>person</mat-icon>
              <span matListItemTitle>Profile</span>
            </a>
            <a mat-list-item routerLink="/system-settings" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>tune</mat-icon>
              <span matListItemTitle>System Settings</span>
            </a>
            <a mat-list-item routerLink="/settings" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>settings</mat-icon>
              <span matListItemTitle>Settings</span>
            </a>
          </mat-nav-list>
          <div class="sidenav-footer">
            <mat-nav-list>
              <a mat-list-item (click)="authService.logout()">
                <mat-icon matListItemIcon>logout</mat-icon>
                <span matListItemTitle>Logout</span>
              </a>
            </mat-nav-list>
            <span class="version-label">v{{ version() }}</span>
          </div>
        </mat-sidenav>

        <mat-sidenav-content class="main-content">
          @if (isMobile()) {
            <mat-toolbar class="mobile-toolbar">
              <button mat-icon-button (click)="mobileSidenavOpen.set(!mobileSidenavOpen())" aria-label="Toggle navigation menu">
                <mat-icon>menu</mat-icon>
              </button>
              <img src="logo.svg" alt="" aria-hidden="true" class="toolbar-logo">
              <span>Control Panel</span>
            </mat-toolbar>
          }
          <div [class.content-below-toolbar]="isMobile()">
            <router-outlet />
          </div>
        </mat-sidenav-content>
      </mat-sidenav-container>
    } @else {
      <router-outlet />
    }
  `,
  styles: [`
    .app-container {
      height: 100vh;
    }
    .sidenav {
      width: 240px;
      background: #fafafa;
      display: flex;
      flex-direction: column;
    }
    .sidenav-header {
      padding: 20px 16px 12px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo {
      width: 40px;
      height: 40px;
      flex-shrink: 0;
    }
    .sidenav-header h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 500;
    }
    .sidenav-footer {
      margin-top: auto;
      border-top: 1px solid #e0e0e0;
    }
    .version-label {
      display: block;
      padding: 4px 16px 8px;
      font-size: 11px;
      color: #999;
    }
    .main-content {
      background: #f5f5f5;
    }
    .content-below-toolbar {
      padding: 16px;
    }
    .mobile-toolbar {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #fafafa;
      border-bottom: 1px solid #e0e0e0;
      gap: 8px;
    }
    .toolbar-logo {
      width: 28px;
      height: 28px;
    }
    .active {
      background: rgba(63, 81, 181, 0.08) !important;
    }
    @media (min-width: 768px) {
      .main-content {
        padding: 24px;
      }
    }
  `],
})
export class AppComponent {
  authService = inject(AuthService);
  private versionService = inject(VersionService);
  version = toSignal(this.versionService.getVersion(), { initialValue: '' });

  mobileSidenavOpen = signal(false);
  isMobile = toSignal(
    inject(BreakpointObserver)
      .observe(MOBILE_BREAKPOINT)
      .pipe(map(result => result.matches)),
    { initialValue: false },
  );

  onSidenavOpenedChange(opened: boolean): void {
    if (this.isMobile()) {
      this.mobileSidenavOpen.set(opened);
    }
  }

  onNavClick(): void {
    if (this.isMobile()) {
      this.mobileSidenavOpen.set(false);
    }
  }
}
