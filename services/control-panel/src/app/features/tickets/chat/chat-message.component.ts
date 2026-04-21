import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BroncoButtonComponent, IconComponent } from '../../../shared/components/index.js';
import { MarkdownPipe } from '../../../shared/pipes/markdown.pipe.js';
import { RelativeTimePipe } from '../../../shared/pipes/relative-time.pipe.js';
import { ChatToolSummaryComponent } from './chat-tool-summary.component.js';
import { ChatModePickerComponent } from './chat-mode-picker.component.js';
import type { ChatIntentLabel, ChatRunMeta, ChatThreadItem } from './chat.types.js';

@Component({
  selector: 'app-chat-message',
  standalone: true,
  imports: [
    CommonModule,
    BroncoButtonComponent,
    IconComponent,
    MarkdownPipe,
    RelativeTimePipe,
    ChatToolSummaryComponent,
    ChatModePickerComponent,
  ],
  template: `
    <div class="chat-bubble" [ngClass]="bubbleClass()">
      <div class="chat-bubble-head">
        <span class="chat-bubble-author">{{ item().authorLabel }}</span>
        <span class="chat-bubble-time" [attr.title]="item().timestamp">{{ item().timestamp | relativeTime }}</span>
      </div>

      @if (item().kind === 'status_change') {
        <div class="status-chip">{{ item().body }}</div>
      } @else if (item().kind === 'placeholder') {
        <div class="chat-placeholder">
          <span class="chat-placeholder-dot"></span>
          <span class="chat-placeholder-dot"></span>
          <span class="chat-placeholder-dot"></span>
          <span class="chat-placeholder-text">{{ item().placeholderText ?? 'Analyzing…' }}</span>
        </div>
      } @else {
        <div class="chat-bubble-body" [innerHTML]="item().body | markdown"></div>

        @if (item().kind === 'analysis' && run(); as r) {
          <div class="chat-analysis-footer">
            <button class="chat-disclosure-btn" type="button" (click)="toggleDisclosure()">
              <app-icon [name]="disclosureOpen() ? 'chevron-up' : 'chevron-down'" size="xs" />
              Called {{ r.toolCount }} tool{{ r.toolCount === 1 ? '' : 's' }} and ran {{ r.subTaskCount }} sub-task{{ r.subTaskCount === 1 ? '' : 's' }}
            </button>
            @if (disclosureOpen()) {
              <app-chat-tool-summary [tools]="r.tools" />
            }
            <app-bronco-button
              variant="ghost"
              size="sm"
              class="chat-view-trace"
              (click)="viewInTrace.emit(item().event?.id ?? '')">
              View in Analysis Trace <app-icon name="arrow-right" size="xs" />
            </app-bronco-button>
          </div>
        }

        @if (item().needsModePick && !item().pickedMode) {
          <app-chat-mode-picker
            [classifiedIntent]="item().classifiedIntent ?? null"
            [disabled]="modePickInFlight()"
            (pick)="pickMode.emit($event)" />
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; margin-bottom: 12px; }
    .chat-bubble {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 12px 16px;
      border-radius: 12px;
      max-width: 82%;
      box-shadow: 0 1px 2px rgba(27, 31, 36, 0.04);
    }
    .chat-bubble.user, .chat-bubble.system {
      margin-left: auto;
      background: var(--surface-subtle, #f6f8fa);
      border: 1px solid var(--border-subtle, #d0d7de);
    }
    .chat-bubble.assistant {
      margin-right: auto;
      background: var(--surface-default, #ffffff);
      border: 1px solid var(--border-subtle, #d0d7de);
    }
    .chat-bubble-head {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted, #57606a);
    }
    .chat-bubble-author { font-weight: 600; color: var(--text-default, #24292f); }
    .chat-bubble-body {
      font-size: 14px;
      line-height: 1.5;
      color: var(--text-default, #24292f);
      word-break: break-word;
    }
    .chat-bubble-body :first-child { margin-top: 0; }
    .chat-bubble-body :last-child { margin-bottom: 0; }
    .chat-bubble-body pre {
      background: var(--surface-subtle, #f6f8fa);
      padding: 8px 12px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 12px;
    }
    .chat-bubble-body code {
      font-family: var(--font-mono, monospace);
      font-size: 0.9em;
    }
    .status-chip {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--surface-subtle, #f6f8fa);
      border: 1px solid var(--border-subtle, #d0d7de);
      align-self: center;
      color: var(--text-muted, #57606a);
    }
    .chat-placeholder {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      color: var(--text-muted, #57606a);
    }
    .chat-placeholder-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      animation: chat-placeholder-pulse 1.2s infinite ease-in-out;
    }
    .chat-placeholder-dot:nth-child(2) { animation-delay: 0.15s; }
    .chat-placeholder-dot:nth-child(3) { animation-delay: 0.3s; }
    .chat-placeholder-text { margin-left: 8px; }
    @keyframes chat-placeholder-pulse {
      0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }
    .chat-analysis-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-top: 6px;
      padding-top: 8px;
      border-top: 1px dashed var(--border-subtle, #d0d7de);
    }
    .chat-disclosure-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      border: none;
      padding: 2px 4px;
      color: var(--text-muted, #57606a);
      font-size: 12px;
      cursor: pointer;
    }
    .chat-disclosure-btn:hover { color: var(--text-default, #24292f); }
    .chat-view-trace { margin-left: auto; }
  `],
})
export class ChatMessageComponent {
  item = input.required<ChatThreadItem>();
  run = input<ChatRunMeta | null>(null);
  modePickInFlight = input<boolean>(false);

  pickMode = output<ChatIntentLabel>();
  viewInTrace = output<string>();

  bubbleClass = computed(() => this.item().role);

  disclosureOpen = signal(false);
  toggleDisclosure(): void { this.disclosureOpen.update((v) => !v); }
}
