import {
  Component,
  Input,
  Output,
  EventEmitter,
  signal,
  ElementRef,
  inject,
  forwardRef,
  OnDestroy,
  HostListener,
  ChangeDetectionStrategy,
} from '@angular/core';

/* ── Dropdown Divider ─────────────────────────────────────── */

@Component({
  standalone: true,
  selector: 'app-dropdown-divider',
  template: `<div class="divider"></div>`,
  styles: [`
    .divider {
      height: 1px;
      background: var(--border-light);
      margin: 4px 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropdownDividerComponent {}

/* ── Dropdown Label (section header) ──────────────────────── */

@Component({
  standalone: true,
  selector: 'app-dropdown-label',
  template: `<div class="label"><ng-content /></div>`,
  styles: [`
    .label {
      padding: 6px 12px 2px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      font-family: var(--font-primary);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropdownLabelComponent {}

/* ── Dropdown Item ────────────────────────────────────────── */

@Component({
  standalone: true,
  selector: 'app-dropdown-item',
  template: `
    <button
      type="button"
      class="dropdown-item"
      [class.destructive]="destructive"
      [class.disabled]="disabled"
      [disabled]="disabled"
      (click)="onClick($event)">
      <ng-content />
    </button>
  `,
  styles: [`
    :host { display: block; }
    .dropdown-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: 32px;
      padding: 0 12px;
      border: none;
      background: none;
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
      transition: background 80ms ease;
    }
    .dropdown-item:hover:not(:disabled) {
      background: var(--bg-hover);
    }
    .dropdown-item.destructive {
      color: var(--color-error);
    }
    .dropdown-item.disabled {
      opacity: 0.4;
      pointer-events: none;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropdownItemComponent {
  @Input() disabled = false;
  @Input() destructive = false;
  @Output() action = new EventEmitter<void>();

  private menu = inject(forwardRef(() => DropdownMenuComponent), { optional: true });

  onClick(_event: Event): void {
    this.action.emit();
    this.menu?.close();
  }
}

/* ── Dropdown Menu (container) ────────────────────────────── */

@Component({
  standalone: true,
  selector: 'app-dropdown-menu',
  template: `
    @if (isOpen()) {
      <div class="dropdown-backdrop" (click)="close()"></div>
      <div class="dropdown-panel" [style.top.px]="posY()" [style.left.px]="posX()" (click)="close()">
        <ng-content />
      </div>
    }
  `,
  styles: [`
    .dropdown-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
    }
    .dropdown-panel {
      position: fixed;
      z-index: 1000;
      min-width: 160px;
      max-height: calc(100vh - 16px);
      overflow-y: auto;
      padding: 4px 0;
      background: var(--bg-card);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card), 0 4px 24px rgba(0, 0, 0, 0.08);
      animation: dropdownIn 120ms ease;
      transform-origin: top right;
    }

    @keyframes dropdownIn {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropdownMenuComponent implements OnDestroy {
  private el = inject(ElementRef);

  // Accepts HTMLElement, ElementRef, or a component instance (resolves nativeElement from host)
  @Input() trigger!: unknown;

  isOpen = signal(false);
  posX = signal(0);
  posY = signal(0);

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  private resolveTriggerElement(): HTMLElement | null {
    const t = this.trigger;
    if (t instanceof HTMLElement) return t;
    if (t instanceof ElementRef) return t.nativeElement;
    // Angular component ref — walk up to find the host element
    if (t && typeof t === 'object' && 'nativeElement' in (t as object)) {
      return (t as ElementRef).nativeElement;
    }
    return null;
  }

  open(): void {
    const triggerEl = this.resolveTriggerElement();

    if (!triggerEl) return;

    const rect: DOMRect = triggerEl.getBoundingClientRect();
    const menuWidth = 180; // approximate, will adjust after render
    // Initial height estimate — refined after render via queueMicrotask once
    // the panel is in the DOM and we can measure it.
    const menuHeightEstimate = 240;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Position below trigger, right-aligned by default
    let x = rect.right - menuWidth;

    // If would overflow left, flip to left-aligned
    if (x < 8) {
      x = rect.left;
    }

    // If would overflow right, clamp
    if (x + menuWidth > viewportWidth - 8) {
      x = viewportWidth - menuWidth - 8;
    }

    this.posX.set(x);
    this.posY.set(this.computeY(rect, menuHeightEstimate, viewportHeight));
    this.isOpen.set(true);

    // Re-measure after the panel renders. The hardcoded 240px estimate can
    // diverge from the real rendered height (tall menus, dense content), and
    // the CSS max-height only caps overflow — it doesn't correct the top
    // position we computed against the estimate. Queue a microtask so the
    // template runs and the DOM node exists, then recompute with the actual
    // height and re-measure the trigger (in case layout shifted).
    queueMicrotask(() => {
      if (!this.isOpen()) return;
      const host = this.el.nativeElement as HTMLElement;
      const panel = host.querySelector<HTMLElement>('.dropdown-panel');
      if (!panel) return;
      const triggerNow = this.resolveTriggerElement();
      if (!triggerNow) return;
      const triggerRect = triggerNow.getBoundingClientRect();
      const actualHeight = panel.getBoundingClientRect().height;
      const adjusted = this.computeY(triggerRect, actualHeight, window.innerHeight);
      if (adjusted !== this.posY()) {
        this.posY.set(adjusted);
      }
    });
  }

  /**
   * Compute the menu's top coordinate given the trigger rect, the menu's
   * height, and the current viewport height. Places the menu below the
   * trigger by default. If that overflows the viewport bottom, flips above
   * the trigger when there is more room there; otherwise clamps into the
   * visible area. Important on mobile where row-action menus near the
   * bottom would otherwise be cut off.
   */
  private computeY(rect: DOMRect, menuHeight: number, viewportHeight: number): number {
    let y = rect.bottom + 4;
    if (y + menuHeight > viewportHeight - 8) {
      const spaceAbove = rect.top - 8;
      const spaceBelow = viewportHeight - rect.bottom - 8;
      if (spaceAbove > spaceBelow) {
        y = Math.max(8, rect.top - menuHeight - 4);
      } else {
        y = Math.max(8, viewportHeight - menuHeight - 8);
      }
    }
    return y;
  }

  close(): void {
    this.isOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen()) {
      this.close();
    }
  }

  ngOnDestroy(): void {
    this.isOpen.set(false);
  }
}
