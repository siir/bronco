import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BroncoButtonComponent } from '../../../shared/components/index.js';
import type { ChatIntentLabel, ChatClassifiedIntent } from './chat.types.js';

@Component({
  selector: 'app-chat-mode-picker',
  standalone: true,
  imports: [CommonModule, BroncoButtonComponent],
  template: `
    <div class="mode-picker">
      <div class="mode-picker-hint">
        How should I handle this reply?
        @if (classifiedIntent(); as ci) {
          <span class="mode-picker-confidence">
            (classifier guess: <strong>{{ ci.label }}</strong>,
            confidence {{ ci.confidence | number:'1.2-2' }})
          </span>
        }
      </div>
      <div class="mode-picker-actions">
        <app-bronco-button variant="secondary" size="sm" (click)="pick.emit('continue')" [disabled]="disabled()">Continue</app-bronco-button>
        <app-bronco-button variant="secondary" size="sm" (click)="pick.emit('refine')" [disabled]="disabled()">Refine</app-bronco-button>
        <app-bronco-button variant="secondary" size="sm" (click)="pick.emit('fresh_start')" [disabled]="disabled()">Fresh start</app-bronco-button>
        <app-bronco-button variant="ghost" size="sm" (click)="pick.emit('not_a_question')" [disabled]="disabled()">Just chat</app-bronco-button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mode-picker {
      margin-top: 8px;
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--surface-subtle, #f6f8fa);
      border: 1px dashed var(--border-subtle, #d0d7de);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .mode-picker-hint {
      font-size: 12px;
      color: var(--text-muted, #57606a);
    }
    .mode-picker-confidence { margin-left: 6px; }
    .mode-picker-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  `],
})
export class ChatModePickerComponent {
  classifiedIntent = input<ChatClassifiedIntent | null>(null);
  disabled = input<boolean>(false);
  pick = output<ChatIntentLabel>();
}
