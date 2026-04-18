export const THEME_COLORS = {
  apple: '#f5f5f7',
  linear: '#08090a',
  sentry: '#1f1633',
  supabase: '#171717',
  nvidia: '#000000',
  vercel: '#ffffff',
} as const;

export type ThemeId = keyof typeof THEME_COLORS;

export const DEFAULT_THEME: ThemeId = 'apple';
