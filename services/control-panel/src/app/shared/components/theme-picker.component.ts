import { Component, inject } from '@angular/core';
import { ThemeService } from '../../core/services/theme.service.js';
import { IconComponent } from './icon.component.js';

/**
 * Shared theme-picker grid. Used by the sidebar theme dialog and the
 * profile page theme section. Reads themes + current selection directly
 * from ThemeService and calls setTheme() on click — no inputs or outputs
 * needed because ThemeService is the single source of truth.
 */
@Component({
  selector: 'app-theme-picker',
  standalone: true,
  imports: [IconComponent],
  template: `
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
  `,
  styles: [`
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
export class ThemePickerComponent {
  readonly themeService = inject(ThemeService);
}
