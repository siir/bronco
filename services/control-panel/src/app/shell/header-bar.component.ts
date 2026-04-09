import { Component, input } from '@angular/core';

@Component({
  selector: 'app-header-bar',
  standalone: true,
  template: `
    <header class="header-bar">
      <span class="page-title">{{ title() }}</span>
      <button class="search-trigger" type="button" aria-label="Search">
        <span class="search-text">Search...</span>
        <kbd class="search-kbd">&#x2318;K</kbd>
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
      font-family: var(--font-primary);
    }
    .page-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
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
      transition: background 120ms ease;
    }
    .search-trigger:hover {
      background: var(--bg-hover);
    }
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
  `],
})
export class HeaderBarComponent {
  title = input<string>('Dashboard');
}
