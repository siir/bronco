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
  ],
  template: `
    @if (authService.currentUser(); as user) {
      <mat-sidenav-container class="app-container">
        <mat-sidenav
          [mode]="isMobile() ? 'over' : 'side'"
          [opened]="!isMobile() || mobileSidenavOpen()"
          (openedChange)="onSidenavOpenedChange($event)"
          class="sidenav"
        >
          <div class="sidenav-header">
            <mat-icon class="header-icon">support_agent</mat-icon>
            <div class="header-text">
              <h2>Client Portal</h2>
              <span class="client-name">{{ user.client?.name ?? '' }}</span>
            </div>
          </div>
          <mat-nav-list>
            <a mat-list-item routerLink="/dashboard" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>dashboard</mat-icon>
              <span matListItemTitle>Dashboard</span>
            </a>
            <a mat-list-item routerLink="/tickets" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" (click)="onNavClick()">
              <mat-icon matListItemIcon>confirmation_number</mat-icon>
              <span matListItemTitle>Tickets</span>
            </a>
            @if (user.userType === 'ADMIN') {
              <a mat-list-item routerLink="/users" routerLinkActive="active" (click)="onNavClick()">
                <mat-icon matListItemIcon>group</mat-icon>
                <span matListItemTitle>Users</span>
              </a>
            }
            <a mat-list-item routerLink="/profile" routerLinkActive="active" (click)="onNavClick()">
              <mat-icon matListItemIcon>person</mat-icon>
              <span matListItemTitle>Profile</span>
            </a>
          </mat-nav-list>
          <div class="sidenav-footer">
            <div class="user-info">
              <mat-icon>account_circle</mat-icon>
              <div>
                <span class="user-name">{{ user.name }}</span>
                <span class="user-type">{{ user.userType }}</span>
              </div>
            </div>
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
              <mat-icon>support_agent</mat-icon>
              <span>Client Portal</span>
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
    .header-icon {
      font-size: 36px;
      width: 36px;
      height: 36px;
      color: #1565c0;
    }
    .sidenav-header h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 500;
    }
    .client-name {
      font-size: 12px;
      color: #666;
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
    .user-info {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px 0;
      color: #555;
    }
    .user-name {
      display: block;
      font-size: 13px;
      font-weight: 500;
    }
    .user-type {
      display: block;
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
    .active {
      background: rgba(21, 101, 192, 0.08) !important;
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
