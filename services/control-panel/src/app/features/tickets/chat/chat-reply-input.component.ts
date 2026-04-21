import { Component, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  BroncoButtonComponent,
  FormFieldComponent,
  SelectComponent,
} from '../../../shared/components/index.js';
import type { ChatIntentLabel } from './chat.types.js';

export type ChatReplyModeSelection = 'auto' | ChatIntentLabel;

export interface ChatReplySubmit {
  text: string;
  mode: ChatReplyModeSelection;
}

@Component({
  selector: 'app-chat-reply-input',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    BroncoButtonComponent,
    FormFieldComponent,
    SelectComponent,
  ],
  template: `
    <div class="reply-input">
      <app-form-field label="Mode">
        <app-select
          [value]="selectedMode()"
          [options]="modeOptions"
          (valueChange)="selectedMode.set($any($event))" />
      </app-form-field>

      <textarea
        class="reply-textarea"
        placeholder="Reply to this ticket — ask a follow-up, request a refinement, or start fresh"
        rows="3"
        [value]="text()"
        (input)="text.set($any($event.target).value)"
        (keydown)="onKeydown($event)"></textarea>

      <app-bronco-button
        variant="primary"
        size="md"
        [disabled]="disabled() || text().trim().length === 0"
        (click)="send()">
        Send
      </app-bronco-button>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .reply-input {
      display: grid;
      grid-template-columns: 170px 1fr auto;
      gap: 8px;
      align-items: end;
      padding: 12px;
      border-top: 1px solid var(--border-subtle, #d0d7de);
      background: var(--surface-default, #ffffff);
    }
    .reply-textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 12px;
      border: 1px solid var(--border-medium, #d0d7de);
      border-radius: var(--radius-md, 6px);
      font-family: var(--font-primary, inherit);
      font-size: 14px;
      resize: vertical;
      outline: none;
      background: var(--bg-card, #ffffff);
      color: var(--text-primary, #24292f);
    }
    .reply-textarea:focus {
      border-color: var(--accent, #0969da);
      box-shadow: 0 0 0 2px var(--focus-ring, rgba(9, 105, 218, 0.3));
    }
    @media (max-width: 768px) {
      .reply-input {
        grid-template-columns: 1fr auto;
      }
      .reply-input app-form-field { grid-column: 1 / -1; }
    }
  `],
})
export class ChatReplyInputComponent {
  text = signal('');
  selectedMode = signal<ChatReplyModeSelection>('auto');

  readonly modeOptions = [
    { value: 'auto', label: 'Auto-detect' },
    { value: 'continue', label: 'Continue' },
    { value: 'refine', label: 'Refine' },
    { value: 'fresh_start', label: 'Fresh start' },
    { value: 'not_a_question', label: 'Just chat' },
  ];

  disabled = signal(false);
  submit = output<ChatReplySubmit>();

  setDisabled(v: boolean): void { this.disabled.set(v); }
  clear(): void { this.text.set(''); this.selectedMode.set('auto'); }

  send(): void {
    const t = this.text().trim();
    if (!t || this.disabled()) return;
    this.submit.emit({ text: t, mode: this.selectedMode() });
  }

  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      this.send();
    }
  }
}
