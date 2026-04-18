import type { IconName } from '../../shared/components/icon-registry.js';

export const NAV_SECTIONS = ['main', 'client', 'operations', 'ai', 'integrations', 'system', 'account'] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

export interface NavRoute {
  /** Canonical route path, e.g. '/tickets'. */
  route: string;
  /** Display label used by the sidebar and (with "Go to " prefix) the palette. */
  label: string;
  /** Icon registry name. */
  icon: IconName;
  /** Which sidebar section this route belongs to. */
  section: NavSection;
}

export const NAV_SECTION_LABELS: Record<NavSection, string> = {
  main: 'Main',
  client: 'Client',
  operations: 'Operations',
  ai: 'AI',
  integrations: 'Integrations',
  system: 'System',
  account: 'Account',
};

export const NAV_ROUTES: readonly NavRoute[] = [
  // Main
  { route: '/dashboard', label: 'Dashboard', icon: 'home', section: 'main' },
  { route: '/tickets', label: 'Tickets', icon: 'ticket', section: 'main' },
  { route: '/activity', label: 'Activity Feed', icon: 'bell', section: 'main' },
  { route: '/clients', label: 'Clients', icon: 'building', section: 'main' },

  // Operations
  { route: '/scheduled-probes', label: 'Scheduled Probes', icon: 'clock', section: 'operations' },
  { route: '/ingestion-jobs', label: 'Ingestion Jobs', icon: 'play', section: 'operations' },
  { route: '/failed-jobs', label: 'Failed Jobs', icon: 'warning', section: 'operations' },
  { route: '/logs', label: 'Logs', icon: 'file', section: 'operations' },
  { route: '/email-logs', label: 'Email Log', icon: 'email', section: 'operations' },

  // AI
  { route: '/prompts', label: 'AI Prompts', icon: 'sparkles', section: 'ai' },
  { route: '/ai-providers', label: 'AI Providers', icon: 'robot', section: 'ai' },
  { route: '/ai-usage', label: 'AI Usage', icon: 'bolt', section: 'ai' },
  { route: '/ticket-routes', label: 'Ticket Routes', icon: 'tag', section: 'ai' },
  { route: '/system-analysis', label: 'System Analysis', icon: 'search', section: 'ai' },
  { route: '/system-issues', label: 'System Issues', icon: 'warning', section: 'ai' },

  // Integrations
  { route: '/slack-conversations', label: 'Slack Conversations', icon: 'comment', section: 'integrations' },
  { route: '/release-notes', label: 'Release Notes', icon: 'book', section: 'integrations' },

  // System
  { route: '/system-status', label: 'System Status', icon: 'server', section: 'system' },
  { route: '/settings', label: 'Settings', icon: 'gear', section: 'system' },
  { route: '/users', label: 'User Maintenance', icon: 'user', section: 'system' },

  // Account
  { route: '/profile', label: 'Profile', icon: 'user', section: 'account' },
  { route: '/notification-preferences', label: 'Notifications', icon: 'bell', section: 'account' },
];
