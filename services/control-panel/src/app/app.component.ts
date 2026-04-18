import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppShellComponent } from './shell/app-shell.component.js';
import { AuthService } from './core/services/auth.service.js';
import { ToastContainerComponent } from './shared/components/toast-container.component.js';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppShellComponent, ToastContainerComponent],
  template: `
    @if (authService.currentUser()) {
      <app-shell />
    } @else {
      <router-outlet />
    }
    <!--
      Toast container lives at the app root so it renders for both the
      shell (authenticated) and the bare router-outlet (login, etc.).
      Previously it was inside AppShellComponent only — login failures
      fired toasts into the void.
    -->
    <app-toast-container />
  `,
})
export class AppComponent {
  readonly authService = inject(AuthService);
}
