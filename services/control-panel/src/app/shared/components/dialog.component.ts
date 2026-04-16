import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

@Component({
  selector: 'app-dialog',
  standalone: true,
  template: `
    @if (open()) {
      <div class="dialog-backdrop" (click)="close()">
        <div
          #panel
          class="dialog-panel"
          role="dialog"
          aria-modal="true"
          [attr.aria-label]="title() || 'Dialog'"
          [style.max-width]="maxWidth()"
          (click)="$event.stopPropagation()">
          <div class="dialog-header">
            @if (title()) {
              <h2 class="dialog-title">{{ title() }}</h2>
            }
            <button type="button" class="dialog-close" aria-label="Close dialog" (click)="close()">&times;</button>
          </div>
          <div class="dialog-body">
            <ng-content />
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 150ms ease;
    }

    .dialog-panel {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      width: 100%;
      max-height: calc(100vh - 48px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: scaleIn 150ms ease;
    }

    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-light);
      flex-shrink: 0;
    }

    .dialog-title {
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .dialog-close {
      width: 28px;
      height: 28px;
      background: none;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 20px;
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 120ms ease;
    }

    .dialog-close:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .dialog-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1 1 auto;
      min-height: 0;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    /*
     * Mobile full-screen variant. Below 768px the dialog fills the viewport:
     * no centering, no rounded corners, no max-width cap (the consumer's
     * inline max-width is overridden via !important). The header is the
     * first flex child of .dialog-panel and naturally pins to the top
     * because only .dialog-body scrolls. The action bar (marked
     * [dialogFooter] inside the projected content) is pinned via a global
     * position: sticky rule in styles.scss — view encapsulation would
     * otherwise block reaching into projected content.
     */
    @media (max-width: 767.98px) {
      .dialog-backdrop {
        align-items: stretch;
        justify-content: stretch;
        animation: none;
      }
      .dialog-panel {
        width: 100% !important;
        max-width: none !important;
        height: 100%;
        max-height: 100%;
        border-radius: 0;
        animation: slideUp 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .dialog-close {
        width: 44px;
        height: 44px;
        font-size: 24px;
      }
    }

    @keyframes slideUp {
      from { transform: translateY(16px); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }
  `],
})
export class DialogComponent {
  title = input<string>('');
  open = input<boolean>(false);
  maxWidth = input<string>('480px');

  openChange = output<boolean>();

  private panelRef = viewChild<ElementRef<HTMLElement>>('panel');
  private previouslyFocused: HTMLElement | null = null;

  constructor() {
    // Manage Escape key + focus restore while the dialog is open.
    effect((onCleanup) => {
      if (!this.open()) return;

      this.previouslyFocused = (typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null);

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          this.close();
        }
      };
      document.addEventListener('keydown', onKeyDown);

      onCleanup(() => {
        document.removeEventListener('keydown', onKeyDown);
        // Restore focus to whatever was focused before the dialog opened.
        if (this.previouslyFocused && typeof this.previouslyFocused.focus === 'function') {
          this.previouslyFocused.focus();
        }
        this.previouslyFocused = null;
      });
    });

    // Auto-focus the first focusable element when the dialog panel mounts.
    effect(() => {
      if (!this.open()) return;
      const panel = this.panelRef()?.nativeElement;
      if (!panel) return;
      queueMicrotask(() => {
        const focusable = panel.querySelector<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        focusable?.focus();
      });
    });
  }

  close(): void {
    this.openChange.emit(false);
  }
}
