import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  duration: number;
}

const DEFAULT_DURATIONS: Record<Toast['type'], number> = {
  success: 3000,
  error: 5000,
  warning: 8000,
  info: 3000,
};

const MAX_VISIBLE = 3;

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);

  success(message: string, duration?: number): void {
    this.add(message, 'success', duration);
  }

  error(message: string, duration?: number): void {
    this.add(message, 'error', duration);
  }

  warning(message: string, duration?: number): void {
    this.add(message, 'warning', duration);
  }

  info(message: string, duration?: number): void {
    this.add(message, 'info', duration);
  }

  dismiss(id: string): void {
    this.toasts.update(list => list.filter(t => t.id !== id));
  }

  private add(message: string, type: Toast['type'], duration?: number): void {
    const toast: Toast = {
      id: generateId(),
      message,
      type,
      duration: duration ?? DEFAULT_DURATIONS[type],
    };

    this.toasts.update(list => {
      const next = [...list, toast];
      while (next.length > MAX_VISIBLE) {
        next.shift();
      }
      return next;
    });

    setTimeout(() => this.dismiss(toast.id), toast.duration);
  }
}
