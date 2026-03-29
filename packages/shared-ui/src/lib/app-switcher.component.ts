import { Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

@Component({
  selector: 'rc-app-switcher',
  standalone: true,
  imports: [MatIconModule, MatMenuModule],
  template: `
    <button type="button" class="app-switcher" [matMenuTriggerFor]="appMenu" aria-label="Switch application">
      <span>{{ currentApp() }}</span>
      <mat-icon class="app-switcher-icon">unfold_more</mat-icon>
    </button>
    <mat-menu #appMenu="matMenu">
      <a mat-menu-item href="/cp/">
        <mat-icon aria-hidden="true">settings</mat-icon>
        <span>Control Panel</span>
      </a>
    </mat-menu>
  `,
  styles: [`
    .app-switcher {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      background: none;
      border: none;
      padding: 0;
      font-size: 12px;
      color: #666;
      cursor: pointer;
      font-family: inherit;
    }
    .app-switcher:hover {
      color: #333;
    }
    .app-switcher:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
      border-radius: 2px;
    }
    .app-switcher-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
  `],
})
export class AppSwitcherComponent {
  currentApp = input.required<string>();
}
