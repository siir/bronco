import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service.js';
import { ApiService } from './api.service.js';
import { ToastService } from './toast.service.js';
import { THEME_COLORS, DEFAULT_THEME, type ThemeId } from './theme-colors.js';

export interface ThemeOption {
  id: ThemeId;
  name: string;
  bodyClass: string;
  description: string;
  isDark: boolean;
  accentColor: string;
}

const THEMES: ThemeOption[] = [
  { id: 'apple', name: 'Apple', bodyClass: '', description: 'Clean light theme with blue accent', isDark: false, accentColor: '#0071e3' },
  { id: 'linear', name: 'Linear', bodyClass: 'theme-linear', description: 'Dark minimal with indigo accent', isDark: true, accentColor: '#5e6ad2' },
  { id: 'nvidia', name: 'NVIDIA', bodyClass: 'theme-nvidia', description: 'Industrial dark with green accent', isDark: true, accentColor: '#76b900' },
  { id: 'sentry', name: 'Sentry', bodyClass: 'theme-sentry', description: 'Deep purple with lime highlights', isDark: true, accentColor: '#6a5fc1' },
  { id: 'supabase', name: 'Supabase', bodyClass: 'theme-supabase', description: 'Dark emerald, border-defined depth', isDark: true, accentColor: '#3ecf8e' },
  { id: 'vercel', name: 'Vercel', bodyClass: 'theme-vercel', description: 'Precise light with monochrome palette', isDark: false, accentColor: '#171717' },
];

const STORAGE_KEY = 'bronco-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  readonly themes: readonly ThemeOption[] = THEMES;
  private readonly _currentTheme = signal<ThemeOption>(this.resolveInitial());
  readonly currentTheme = this._currentTheme.asReadonly();

  private initialized = false;

  constructor() {
    // When the auth user arrives (or changes), sync the theme from the server
    // value if it differs from what we applied optimistically.
    effect(() => {
      const user = this.auth.currentUser();
      if (!user?.themePreference) return;
      const serverTheme = THEMES.find(t => t.id === user.themePreference);
      if (!serverTheme) return;
      if (serverTheme.id !== this._currentTheme().id) {
        this._currentTheme.set(serverTheme);
        this.applyTheme();
      }
    });
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    // Apply immediately from the localStorage-resolved initial theme to avoid
    // a flash between page load and the auth/me response. The constructor
    // effect will reconcile with the server value once it's available.
    this.applyTheme();
  }

  cycleToNext(): ThemeOption {
    const current = this._currentTheme();
    const idx = THEMES.findIndex(t => t.id === current.id);
    const next = THEMES[(idx + 1) % THEMES.length];
    this.setTheme(next.id);
    return next;
  }

  setTheme(id: string): void {
    const theme = THEMES.find(t => t.id === id);
    if (!theme) return;
    this._currentTheme.set(theme);
    this.applyTheme();
    this.persistToServer(theme.id);
  }

  private persistToServer(themePreference: string): void {
    this.api
      .patch<{ themePreference: string }>('/auth/me/theme', { themePreference })
      .subscribe({
        next: () => {
          // Keep the currentUser signal in sync so the effect doesn't fight us.
          const user = this.auth.currentUser();
          if (user && user.themePreference !== themePreference) {
            this.auth.currentUser.set({ ...user, themePreference });
          }
        },
        error: () => {
          // Non-fatal: the theme is already applied locally and stored in
          // localStorage. It will sync on next successful save or page load.
          this.toast.warning('Theme preference could not be saved to the server');
        },
      });
  }

  private applyTheme(): void {
    const theme = this.currentTheme();
    const classList = document.body.classList;
    const toRemove = Array.from(classList).filter(c => c.startsWith('theme-'));
    toRemove.forEach(c => classList.remove(c));
    if (theme.bodyClass) {
      classList.add(theme.bodyClass);
    }
    localStorage.setItem(STORAGE_KEY, theme.id);
    this.applyThemeColorMeta();
  }

  private applyThemeColorMeta(): void {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const theme = this.currentTheme();
    const computed = getComputedStyle(document.body).getPropertyValue('--bg-page').trim();
    const color = computed || THEME_COLORS[theme.id] || THEME_COLORS[DEFAULT_THEME];
    meta.content = color;
    // Clear the inline background style set by the pre-boot script in
    // index.html. That inline style exists only to cover first-paint on iOS
    // Safari; after Angular boots and applies the body class, the CSS rule
    // `html, body { background: var(--bg-page) }` takes over. If we leave
    // the inline style in place, it beats the CSS rule via specificity and
    // the safe-area strip stays pinned to whatever the initial theme was
    // even after the user switches themes.
    document.documentElement.style.removeProperty('background');
  }

  private resolveInitial(): ThemeOption {
    const saved = localStorage.getItem(STORAGE_KEY);
    return THEMES.find(t => t.id === saved) ?? THEMES[0];
  }
}
