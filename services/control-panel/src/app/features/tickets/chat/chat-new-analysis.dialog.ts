import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  BroncoButtonComponent,
  DialogComponent,
  FormFieldComponent,
  SelectComponent,
} from '../../../shared/components/index.js';
import type { ChatReanalysisMode } from './chat.types.js';

export interface ChatNewAnalysisSubmit {
  text: string;
  mode: ChatReanalysisMode;
}

@Component({
  selector: 'app-chat-new-analysis-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogComponent,
    BroncoButtonComponent,
    FormFieldComponent,
    SelectComponent,
  ],
  template: `
    <app-dialog
      [open]="open()"
      title="Start a new analysis run"
      maxWidth="520px"
      (openChange)="onOpenChange($event)">
      <p class="hint">
        This posts a synthetic chat message as you and kicks off a re-analysis with the chosen mode.
      </p>

      <app-form-field label="Mode">
        <app-select
          [value]="mode()"
          [options]="modeOptions"
          (valueChange)="mode.set($any($event))" />
      </app-form-field>

      <app-form-field label="Prompt">
        <textarea
          class="prompt-textarea"
          rows="5"
          placeholder="What should the assistant do on this run?"
          [value]="text()"
          (input)="text.set($any($event.target).value)"></textarea>
      </app-form-field>

      <div class="dialog-actions" dialogFooter>
        <app-bronco-button variant="ghost" (click)="cancel.emit()">Cancel</app-bronco-button>
        <app-bronco-button
          variant="primary"
          [disabled]="text().trim().length === 0"
          (click)="submit()">
          Start run
        </app-bronco-button>
      </div>
    </app-dialog>
  `,
  styles: [`
    :host { display: block; }
    .hint {
      margin: 0 0 12px;
      font-size: 12px;
      color: var(--text-muted, #57606a);
    }
    .prompt-textarea {
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
    .prompt-textarea:focus {
      border-color: var(--accent, #0969da);
      box-shadow: 0 0 0 2px var(--focus-ring, rgba(9, 105, 218, 0.3));
    }
    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 12px;
    }
  `],
})
export class ChatNewAnalysisDialogComponent {
  open = input<boolean>(false);

  readonly modeOptions = [
    { value: 'continue', label: 'Continue' },
    { value: 'refine', label: 'Refine' },
    { value: 'fresh_start', label: 'Fresh start' },
  ];

  text = signal('');
  mode = signal<ChatReanalysisMode>('continue');

  submitted = output<ChatNewAnalysisSubmit>();
  cancel = output<void>();

  submit(): void {
    const t = this.text().trim();
    if (!t) return;
    this.submitted.emit({ text: t, mode: this.mode() });
  }

  onOpenChange(open: boolean): void {
    if (!open) this.cancel.emit();
  }

  reset(): void {
    this.text.set('');
    this.mode.set('continue');
  }
}
