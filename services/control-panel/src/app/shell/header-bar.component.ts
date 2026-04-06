import { Component } from '@angular/core';

@Component({
  selector: 'app-header-bar',
  standalone: true,
  template: `
    <header class="header-bar">
      <div class="header-left">
        <h1 class="page-title">Dashboard</h1>
      </div>
      <div class="header-right">
        <div class="search-trigger">
          <span class="material-icons search-icon">search</span>
          <span class="search-placeholder">Search...</span>
          <kbd class="search-kbd">⌘K</kbd>
        </div>
      </div>
    </header>
  `,
  styles: [`
    .header-bar {
      height: var(--header-height);
      background: var(--bg-header);
      backdrop-filter: saturate(180%) blur(20px);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      border-bottom: 1px solid var(--border-light);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      flex-shrink: 0;
    }

    .header-left {
      display: flex;
      align-items: center;
    }

    .page-title {
      font-family: var(--font-primary);
      font-size: 17px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .header-right {
      display: flex;
      align-items: center;
    }

    .search-trigger {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--bg-muted);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: background 120ms ease;
    }

    .search-trigger:hover {
      background: var(--bg-hover);
    }

    .search-icon {
      font-size: 16px;
      color: var(--text-tertiary);
    }

    .search-placeholder {
      font-family: var(--font-primary);
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
      line-height: 1.4;
    }
  `],
})
export class HeaderBarComponent {}
