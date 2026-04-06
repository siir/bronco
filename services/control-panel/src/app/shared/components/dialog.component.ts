import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-dialog',
  standalone: true,
  template: `
    @if (open()) {
      <div class="dialog-backdrop" (click)="close()">
        <div class="dialog-panel" [style.max-width]="maxWidth()" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            @if (title()) {
              <h2 class="dialog-title">{{ title() }}</h2>
            }
            <button class="dialog-close" (click)="close()">&times;</button>
          </div>
          <div class="dialog-body">
            <ng-content />
          </div>
          <div class="dialog-footer">
            <ng-content select="[dialogFooter]" />
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
      overflow: hidden;
      animation: scaleIn 150ms ease;
    }

    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-light);
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
    }

    .dialog-footer {
      padding: 12px 20px;
      border-top: 1px solid var(--border-light);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .dialog-footer:empty {
      display: none;
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

  close(): void {
    this.openChange.emit(false);
  }
}
