import { Component, inject } from '@angular/core';
import { ToastService, type Toast } from '../../core/services/toast.service.js';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  template: `
    <div class="toast-stack">
      @for (toast of toastService.toasts(); track toast.id) {
        <div class="toast" [class]="'toast-' + toast.type" @slideIn>
          <span class="toast-message">{{ toast.message }}</span>
          <button class="toast-dismiss" (click)="toastService.dismiss(toast.id)" aria-label="Dismiss">&times;</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .toast-stack {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 280px;
      max-width: 420px;
      padding: 12px 16px;
      border-radius: 8px;
      border-left: 4px solid;
      background: var(--bg-card);
      box-shadow: var(--shadow-card);
      color: var(--text-primary);
      font-size: 13px;
      font-family: var(--font-primary);
      pointer-events: auto;
      animation: toastSlideIn 0.25s ease-out;
    }

    .toast-success {
      border-left-color: var(--color-success);
      background: color-mix(in srgb, var(--color-success) 8%, var(--bg-card));
    }

    .toast-error {
      border-left-color: var(--color-error);
      background: color-mix(in srgb, var(--color-error) 8%, var(--bg-card));
    }

    .toast-warning {
      border-left-color: var(--color-warning);
      background: color-mix(in srgb, var(--color-warning) 8%, var(--bg-card));
    }

    .toast-info {
      border-left-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 8%, var(--bg-card));
    }

    .toast-message {
      flex: 1;
      line-height: 1.4;
      letter-spacing: -0.1px;
    }

    .toast-dismiss {
      flex-shrink: 0;
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 18px;
      cursor: pointer;
      padding: 0 2px;
      line-height: 1;
      opacity: 0.6;
      transition: opacity 0.15s ease;
    }

    .toast-dismiss:hover {
      opacity: 1;
    }

    @keyframes toastSlideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
  `],
})
export class ToastContainerComponent {
  readonly toastService = inject(ToastService);
}
