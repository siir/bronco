import { Injectable, inject } from '@angular/core';
import { BreakpointObserver } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

/**
 * Responsive viewport service.
 *
 * Exposes `isMobile` as a signal backed by CDK BreakpointObserver. The single
 * shell breakpoint — `(max-width: 767.98px)` — must be kept in sync with the
 * media queries used in component CSS (sidebar, header, shell content, etc.)
 * so the CSS branches and the template branches agree.
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly bp = inject(BreakpointObserver);

  /** True when viewport is below the shell mobile breakpoint. */
  readonly isMobile = toSignal(
    this.bp.observe('(max-width: 767.98px)').pipe(map(r => r.matches)),
    { initialValue: false },
  );
}
