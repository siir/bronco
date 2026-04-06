import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppShellComponent } from './shell/app-shell.component';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppShellComponent],
  template: `
    @if (authService.currentUser()) {
      <app-shell />
    } @else {
      <router-outlet />
    }
  `,
})
export class AppComponent {
  readonly authService = inject(AuthService);
}
