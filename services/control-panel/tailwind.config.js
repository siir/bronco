/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      colors: {
        page: 'var(--bg-page)',
        card: 'var(--bg-card)',
        sidebar: 'var(--bg-sidebar)',
        header: 'var(--bg-header)',
        panel: 'var(--bg-panel)',
        hover: 'var(--bg-hover)',
        active: 'var(--bg-active)',
        muted: 'var(--bg-muted)',
        accent: 'var(--accent)',
        'accent-link': 'var(--accent-link)',
        'accent-hover': 'var(--accent-hover)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        error: 'var(--color-error)',
        info: 'var(--color-info)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-on-accent': 'var(--text-on-accent)',
      },
      borderColor: {
        light: 'var(--border-light)',
        medium: 'var(--border-medium)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        pill: 'var(--radius-pill)',
      },
      width: {
        sidebar: 'var(--sidebar-width)',
        'detail-panel': 'var(--detail-panel-width)',
      },
      height: {
        header: 'var(--header-height)',
      },
      fontFamily: {
        primary: 'var(--font-primary)',
      },
    },
  },
  plugins: [],
};
