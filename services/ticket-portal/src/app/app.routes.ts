import { Routes } from '@angular/router';
import { authGuard, adminGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: 'register',
    loadComponent: () => import('./features/register/register.component').then(m => m.RegisterComponent),
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
        path: 'tickets',
        loadComponent: () => import('./features/tickets/ticket-list.component').then(m => m.TicketListComponent),
      },
      {
        path: 'tickets/new',
        loadComponent: () => import('./features/tickets/ticket-create.component').then(m => m.TicketCreateComponent),
      },
      {
        path: 'tickets/:id',
        loadComponent: () => import('./features/tickets/ticket-detail.component').then(m => m.TicketDetailComponent),
      },
      {
        path: 'users',
        canActivate: [adminGuard],
        loadComponent: () => import('./features/users/user-list.component').then(m => m.UserListComponent),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent),
      },
    ],
  },
];
