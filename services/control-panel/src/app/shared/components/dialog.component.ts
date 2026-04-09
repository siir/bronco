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
