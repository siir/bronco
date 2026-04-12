import { Routes, RedirectFunction } from '@angular/router';
import { inject } from '@angular/core';
import { authGuard } from './core/guards/auth.guard';
import { scopedOpsGuard } from './core/guards/scoped-ops.guard';
import { AuthService } from './core/services/auth.service';

/**
 * Default redirect for the `/` path. Operators go to /dashboard; scoped ops
 * users go straight to their own client detail page.
 */
const defaultRedirect: RedirectFunction = () => {
  const auth = inject(AuthService);
  const user = auth.currentUser();
  if (user?.isPortalOpsUser && user.clientId) {
    return `/clients/${user.clientId}`;
  }
  return '/dashboard';
};

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: defaultRedirect },
      {
        path: 'dashboard',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
      },
      {
        path: 'clients',
        canActivate: [scopedOpsGuard],
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
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/prompts/prompt-list.component').then(m => m.PromptListComponent),
      },
      {
        path: 'prompts/:key',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/prompts/prompt-detail.component').then(m => m.PromptDetailComponent),
      },
      {
        path: 'logs',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/logs/log-viewer.component').then(m => m.LogViewerComponent),
      },
      {
        path: 'email-logs',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/email-logs/email-log.component').then(m => m.EmailLogComponent),
      },
      {
        path: 'slack-conversations',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/slack-conversations/slack-conversations.component').then(m => m.SlackConversationsComponent),
      },
      {
        path: 'ai-usage',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/ai-usage/ai-usage.component').then(m => m.AiUsageComponent),
      },
      {
        path: 'ai-providers',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/ai-providers/ai-providers.component').then(m => m.AiProvidersComponent),
      },
      {
        path: 'activity',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/activity-feed/activity-feed.component').then(m => m.ActivityFeedComponent),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent),
      },
      {
        path: 'system-status',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/system-status/system-status.component').then(m => m.SystemStatusComponent),
      },
      {
        path: 'failed-jobs',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/failed-jobs/failed-job-list.component').then(m => m.FailedJobListComponent),
      },
      {
        path: 'system-issues',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/system-issues/system-issues.component').then(m => m.SystemIssuesComponent),
      },
      {
        path: 'system-analysis',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/system-analysis/system-analysis.component').then(m => m.SystemAnalysisComponent),
      },
      {
        path: 'notification-preferences',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/notification-preferences/notification-preferences.component').then(m => m.NotificationPreferencesComponent),
      },
      {
        path: 'system-settings',
        redirectTo: '/cp/settings?tab=smtp',
        pathMatch: 'full',
      },
      {
        path: 'settings',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent),
      },
      {
        path: 'release-notes',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/release-notes/release-notes.component').then(m => m.ReleaseNotesComponent),
      },
      {
        path: 'ticket-routes',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/ticket-routes/ticket-route-list.component').then(m => m.TicketRouteListComponent),
      },
      {
        path: 'ingestion-jobs',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/ingestion-jobs/ingestion-job-list.component').then(m => m.IngestionJobListComponent),
      },
      {
        path: 'scheduled-probes',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/scheduled-probes/probe-list.component').then(m => m.ProbeListComponent),
      },
      {
        path: 'scheduled-probes/:id/runs',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/scheduled-probes/probe-runs.component').then(m => m.ProbeRunsComponent),
      },
      {
        path: 'users',
        canActivate: [scopedOpsGuard],
        loadComponent: () => import('./features/users/user-list.component').then(m => m.UserListComponent),
      },
    ],
  },
];
