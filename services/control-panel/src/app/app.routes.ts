import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
      },
      {
        path: 'clients',
        loadComponent: () => import('./features/clients/client-list.component').then(m => m.ClientListComponent),
      },
      {
        path: 'clients/:id',
        loadComponent: () => import('./features/clients/client-detail.component').then(m => m.ClientDetailComponent),
      },
      {
        path: 'tickets',
        loadComponent: () => import('./features/tickets/ticket-list.component').then(m => m.TicketListComponent),
      },
      {
        path: 'tickets/:id',
        loadComponent: () => import('./features/tickets/ticket-detail.component').then(m => m.TicketDetailComponent),
      },
      {
        path: 'prompts',
        loadComponent: () => import('./features/prompts/prompt-list.component').then(m => m.PromptListComponent),
      },
      {
        path: 'prompts/:key',
        loadComponent: () => import('./features/prompts/prompt-detail.component').then(m => m.PromptDetailComponent),
      },
      {
        path: 'logs',
        loadComponent: () => import('./features/logs/log-viewer.component').then(m => m.LogViewerComponent),
      },
      {
        path: 'email-logs',
        loadComponent: () => import('./features/email-logs/email-log.component').then(m => m.EmailLogComponent),
      },
      {
        path: 'slack-conversations',
        loadComponent: () => import('./features/slack-conversations/slack-conversations.component').then(m => m.SlackConversationsComponent),
      },
      {
        path: 'ai-usage',
        loadComponent: () => import('./features/ai-usage/ai-usage.component').then(m => m.AiUsageComponent),
      },
      {
        path: 'ai-providers',
        loadComponent: () => import('./features/ai-providers/ai-providers.component').then(m => m.AiProvidersComponent),
      },
      {
        path: 'activity',
        loadComponent: () => import('./features/activity-feed/activity-feed.component').then(m => m.ActivityFeedComponent),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent),
      },
      {
        path: 'system-status',
        loadComponent: () => import('./features/system-status/system-status.component').then(m => m.SystemStatusComponent),
      },
      {
        path: 'failed-jobs',
        loadComponent: () => import('./features/failed-jobs/failed-job-list.component').then(m => m.FailedJobListComponent),
      },
      {
        path: 'system-issues',
        loadComponent: () => import('./features/system-issues/system-issues.component').then(m => m.SystemIssuesComponent),
      },
      {
        path: 'system-analysis',
        loadComponent: () => import('./features/system-analysis/system-analysis.component').then(m => m.SystemAnalysisComponent),
      },
      {
        path: 'notification-preferences',
        loadComponent: () => import('./features/notification-preferences/notification-preferences.component').then(m => m.NotificationPreferencesComponent),
      },
      {
        path: 'system-settings',
        redirectTo: '/cp/settings?tab=smtp',
        pathMatch: 'full',
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent),
      },
      {
        path: 'release-notes',
        loadComponent: () => import('./features/release-notes/release-notes.component').then(m => m.ReleaseNotesComponent),
      },
      {
        path: 'ticket-routes',
        loadComponent: () => import('./features/ticket-routes/ticket-route-list.component').then(m => m.TicketRouteListComponent),
      },
      {
        path: 'ingestion-jobs',
        loadComponent: () => import('./features/ingestion-jobs/ingestion-job-list.component').then(m => m.IngestionJobListComponent),
      },
      {
        path: 'scheduled-probes',
        loadComponent: () => import('./features/scheduled-probes/probe-list.component').then(m => m.ProbeListComponent),
      },
      {
        path: 'scheduled-probes/:id/runs',
        loadComponent: () => import('./features/scheduled-probes/probe-runs.component').then(m => m.ProbeRunsComponent),
      },
      {
        path: 'users',
        loadComponent: () => import('./features/users/user-list.component').then(m => m.UserListComponent),
      },
    ],
  },
];
