import { Injectable, signal, inject, DestroyRef } from '@angular/core';
import { Router, NavigationEnd, NavigationSkipped } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

/**
 * Sidebar drawer state.
 *
 * On desktop (`>= 1200px`) the sidebar is rendered inline in the shell flex
 * layout and this service is unused. In compact layout (`< 1200px`) the
 * sidebar is rendered via a CDK Overlay drawer and the shell subscribes to
 * `isOpen` to attach/detach the overlay. The drawer auto-closes on any
 * successful route navigation so tapping a nav link both navigates and
 * dismisses the drawer.
 */
@Injectable({ providedIn: 'root' })
export class SidebarService {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly isOpen = signal(false);

  constructor() {
    // Any completed navigation closes the drawer. Also listen for
    // NavigationSkipped — Angular's default `onSameUrlNavigation: 'ignore'`
    // suppresses NavigationEnd when a user taps a link for the already-active
    // route (e.g. already on /dashboard and tapping "Dashboard" in the
    // drawer), which would otherwise leave the drawer stuck open.
    this.router.events
      .pipe(
        filter(e => e instanceof NavigationEnd || e instanceof NavigationSkipped),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.close());
  }

  open(): void { this.isOpen.set(true); }
  close(): void { this.isOpen.set(false); }
  toggle(): void { this.isOpen.update(v => !v); }
}
