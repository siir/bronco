import { Injectable, signal } from '@angular/core';

export interface ThemeOption {
  id: string;
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
  readonly themes: readonly ThemeOption[] = THEMES;
  private readonly _currentTheme = signal<ThemeOption>(this.resolveInitial());
  readonly currentTheme = this._currentTheme.asReadonly();

  init(): void {
    this.applyTheme();
  }

  setTheme(id: string): void {
    const theme = THEMES.find(t => t.id === id);
    if (!theme) return;
    this._currentTheme.set(theme);
    this.applyTheme();
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
  }

  private resolveInitial(): ThemeOption {
    const saved = localStorage.getItem(STORAGE_KEY);
    return THEMES.find(t => t.id === saved) ?? THEMES[0];
  }
}
