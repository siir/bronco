import { Component, inject, input } from '@angular/core';
import { IconComponent } from '../shared/components/icon.component.js';
import { ViewportService } from '../core/services/viewport.service.js';
import { SidebarService } from '../core/services/sidebar.service.js';
import { CommandPaletteService } from '../core/services/command-palette.service.js';

const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

@Component({
  selector: 'app-header-bar',
  standalone: true,
  imports: [IconComponent],
  template: `
    <header class="header-bar">
      <div class="header-left">
        @if (viewport.isCompactLayout()) {
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
      <button class="search-trigger" type="button" aria-label="Search" (click)="paletteService.open()">
        <app-icon class="search-icon" name="search" size="sm" />
        <span class="search-text">Search...</span>
        @if (!viewport.isCompactLayout()) {
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
      padding-top: env(safe-area-inset-top);
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
     * Compact-layout mode: reduce horizontal padding, collapse the search
     * trigger to an icon-only 44x44 hit area, and hide the "Search..." text.
     * The kbd hint is hidden via the template @if (isCompactLayout). The
     * hamburger satisfies the 44px tap target on the left.
     */
    @media (max-width: 1199.98px) {
      .header-bar { padding-left: 12px; padding-right: 12px; padding-bottom: 0; }
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
  readonly paletteService = inject(CommandPaletteService);
  title = input<string>('Dashboard');
  readonly shortcutHint = isMac ? '⌘K' : 'Ctrl+K';
}
