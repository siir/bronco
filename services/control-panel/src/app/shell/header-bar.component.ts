import { Component, inject, input } from '@angular/core';
import { IconComponent } from '../shared/components/icon.component';
import { ViewportService } from '../core/services/viewport.service';
import { SidebarService } from '../core/services/sidebar.service';

const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
const isMobileUA = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

@Component({
  selector: 'app-header-bar',
  standalone: true,
  imports: [IconComponent],
  template: `
    <header class="header-bar">
      <div class="header-left">
        @if (viewport.isMobile()) {
          <button
            class="hamburger-btn"
            type="button"
            aria-label="Open navigation menu"
            (click)="sidebar.toggle()"
          >
            <app-icon name="menu" size="md" />
          </button>
        }
        <span class="page-title">{{ title() }}</span>
      </div>
      <button class="search-trigger" type="button" aria-label="Search">
        <app-icon class="search-icon" name="search" size="sm" />
        <span class="search-text">Search...</span>
        @if (!isMobileUA) {
          <kbd class="search-kbd">{{ shortcutHint }}</kbd>
        }
      </button>
    </header>
  `,
  styles: [`
    .header-bar {
      height: var(--header-height);
      min-height: var(--header-height);
      background: var(--bg-header);
      backdrop-filter: saturate(180%) blur(20px);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      border-bottom: 1px solid var(--border-light);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      gap: 12px;
      font-family: var(--font-primary);
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }
    .hamburger-btn {
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-primary);
      flex-shrink: 0;
      transition: background 120ms ease;
    }
    .hamburger-btn:hover { background: var(--bg-hover); }
    .page-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .search-trigger {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--bg-muted);
      border: none;
      border-radius: var(--radius-pill);
      cursor: pointer;
      font-family: var(--font-primary);
      flex-shrink: 0;
      transition: background 120ms ease;
    }
    .search-trigger:hover {
      background: var(--bg-hover);
    }
    /* Desktop: search icon is visual-only (text carries the affordance). */
    .search-icon { display: none; color: var(--text-tertiary); }
    .search-text {
      font-size: 13px;
      color: var(--text-tertiary);
    }
    .search-kbd {
      font-family: var(--font-primary);
      font-size: 11px;
      color: var(--text-tertiary);
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: 4px;
      padding: 1px 5px;
    }

    /*
     * Mobile compact mode: reduce horizontal padding, collapse the search
     * trigger to an icon-only 44x44 hit area, and hide the "Search..." text
     * and kbd hint. The hamburger already satisfies the 44px tap target on
     * the left. The title stretches to fill the middle and truncates with
     * ellipsis when it doesn't fit.
     */
    @media (max-width: 767.98px) {
      .header-bar { padding: 0 12px; }
      .search-trigger {
        width: 44px;
        height: 44px;
        padding: 0;
        justify-content: center;
        background: none;
      }
      .search-trigger:hover { background: var(--bg-hover); }
      .search-icon { display: inline-flex; }
      .search-text { display: none; }
    }
  `],
})
export class HeaderBarComponent {
  readonly viewport = inject(ViewportService);
  readonly sidebar = inject(SidebarService);
  title = input<string>('Dashboard');
  readonly isMobileUA = isMobileUA;
  readonly shortcutHint = isMac ? '⌘K' : 'Ctrl+K';
}
