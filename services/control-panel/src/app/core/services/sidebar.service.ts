import { Injectable, signal, inject, DestroyRef } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

/**
 * Mobile sidebar drawer state.
 *
 * On desktop (`>= 768px`) the sidebar is rendered inline in the shell flex
 * layout and this service is unused. On mobile the sidebar is rendered via a
 * CDK Overlay drawer and the shell subscribes to `isOpen` to attach/detach
 * the overlay. The drawer auto-closes on any successful route navigation so
 * tapping a nav link both navigates and dismisses the drawer.
 */
@Injectable({ providedIn: 'root' })
export class SidebarService {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly isOpen = signal(false);

  constructor() {
    // Any completed navigation closes the drawer. This covers nav-link taps,
    // programmatic navigations from within the drawer, and browser history.
    this.router.events
      .pipe(
        filter(e => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.close());
  }

  open(): void { this.isOpen.set(true); }
  close(): void { this.isOpen.set(false); }
  toggle(): void { this.isOpen.update(v => !v); }
}
