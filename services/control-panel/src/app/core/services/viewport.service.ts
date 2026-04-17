import { Injectable, inject } from '@angular/core';
import { BreakpointObserver } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

/**
 * Responsive viewport service.
 *
 * Two breakpoints:
 *   - `isMobile` (< 768px) governs phone-only behavior: form-input sizing
 *     (iOS zoom prevention), DataTable card mode, full-screen dialogs, mobile
 *     action affordances, etc.
 *   - `isCompactLayout` (< 1200px) governs the shell: at narrower widths the
 *     sidebar + main + 380px detail pane can't comfortably coexist inline, so
 *     the sidebar collapses to a drawer and the detail view becomes a routed
 *     full-width takeover.
 *
 * Each signal must stay in sync with the matching media queries used in
 * component CSS so the template branches and CSS branches agree.
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly bp = inject(BreakpointObserver);

  /** True when viewport is below the shell mobile breakpoint (< 768px). */
  readonly isMobile = toSignal(
    this.bp.observe('(max-width: 767.98px)').pipe(map(r => r.matches)),
    { initialValue: false },
  );

  /**
   * True when viewport is narrow enough that sidebar + detail pane can't
   * comfortably coexist inline with main content (< 1200px).
   */
  readonly isCompactLayout = toSignal(
    this.bp.observe('(max-width: 1199.98px)').pipe(map(r => r.matches)),
    { initialValue: false },
  );
}
