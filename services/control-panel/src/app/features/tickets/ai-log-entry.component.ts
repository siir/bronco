import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BroncoButtonComponent } from '../../shared/components/index.js';
import { type UnifiedLogEntry } from '../../core/services/ticket.service';

@Component({
  selector: 'app-ai-log-entry',
  standalone: true,
  imports: [CommonModule, BroncoButtonComponent],
  template: `
    <div class="ai-log-entry unified-type-ai" [class.iteration-grouped]="iterationGrouped()">
      <!-- Header row -->
      <div class="log-entry-header">
        <span class="log-seq">#{{ idx() + 1 }}</span>
        <span class="log-time" tabindex="0" [attr.title]="entry().timestamp" [attr.aria-label]="entry().timestamp">{{ formatTime(entry().timestamp) }}</span>
        <span class="unified-type-badge ubadge-ai">AI</span>
        <span class="meta-chip provider-chip provider-{{ (entry().provider ?? '').toLowerCase() }}">{{ entry().provider }}</span>
        <code class="meta-chip model-chip">{{ entry().model }}</code>
        <span class="meta-chip task-chip">{{ entry().taskType }}</span>
        <span class="meta-chip token-chip">{{ entry().inputTokens | number }}in / {{ entry().outputTokens | number }}out</span>
        @if (entry().durationMs != null) {
          <span class="meta-chip duration-chip">{{ entry().durationMs | number }}ms</span>
        }
        @if (entry().costUsd != null) {
          <span class="ai-usage-cost">\${{ entry().costUsd | number:'1.4-4' }}</span>
        }
      </div>

      <!-- Prompt -->
      @if (promptText()) {
        <div class="inline-text-block">
          <span class="inline-block-label">Prompt</span>
          <pre class="inline-text-content" [class.clamped]="!promptExpanded">{{ promptExpanded ? promptText() : firstLine(promptText()!) }}</pre>
          @if (isMultiline(promptText()!)) {
            <app-bronco-button variant="ghost" size="sm" [ariaExpanded]="promptExpanded" [ariaLabel]="promptExpanded ? 'Collapse prompt' : 'Expand prompt'" (click)="promptExpanded = !promptExpanded">
              {{ promptExpanded ? 'less' : 'more' }}
              <span aria-hidden="true">{{ promptExpanded ? '⏶' : '⏷' }}</span>
            </app-bronco-button>
          }
        </div>
      }

      <!-- Response -->
      @if (responseText()) {
        <div class="inline-text-block">
          <span class="inline-block-label">Response</span>
          <pre class="inline-text-content" [class.clamped]="!responseExpanded">{{ responseExpanded ? responseText() : firstLine(responseText()!) }}</pre>
          @if (isMultiline(responseText()!)) {
            <app-bronco-button variant="ghost" size="sm" [ariaExpanded]="responseExpanded" [ariaLabel]="responseExpanded ? 'Collapse response' : 'Expand response'" (click)="responseExpanded = !responseExpanded">
              {{ responseExpanded ? 'less' : 'more' }}
              <span aria-hidden="true">{{ responseExpanded ? '⏶' : '⏷' }}</span>
            </app-bronco-button>
          }
        </div>
      }

      <!-- More data (system prompt, prompt key, conversation metadata, archive stats) -->
      @if (hasMoreData()) {
        <app-bronco-button variant="ghost" size="sm" [ariaExpanded]="moreDataExpanded" [ariaLabel]="moreDataExpanded ? 'Collapse details' : 'Expand details'" (click)="moreDataExpanded = !moreDataExpanded">
          {{ moreDataExpanded ? 'less data' : 'more data' }}
          <span aria-hidden="true">{{ moreDataExpanded ? '▴' : '▾' }}</span>
        </app-bronco-button>
        @if (moreDataExpanded) {
          <div class="ai-detail-sections">
            @if (entry().promptKey) {
              <div class="ai-detail-label">Prompt Key: <code>{{ entry().promptKey }}</code></div>
            }
            @if (systemPromptText()) {
              <div class="ai-detail-block">
                <app-bronco-button variant="ghost" size="sm" class="sys-prompt-toggle" [ariaExpanded]="systemPromptExpanded" (click)="systemPromptExpanded = !systemPromptExpanded">
                  System Prompt
                  <span aria-hidden="true">{{ systemPromptExpanded ? '▴' : '▾' }}</span>
                </app-bronco-button>
                @if (systemPromptExpanded) {
                  <pre class="log-metadata">{{ systemPromptText() }}</pre>
                }
              </div>
            }
            @if (entry().conversationMetadata) {
              <div class="ai-detail-block">
                <div class="ai-detail-label">Conversation Metadata</div>
                <pre class="log-metadata">{{ entry().conversationMetadata | json }}</pre>
              </div>
            }
            @if (entry().archive?.messageCount != null) {
              <div class="ai-detail-label">Messages: {{ entry().archive?.messageCount }} &middot; Context tokens: {{ entry().archive?.totalContextTokens | number }}</div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .ai-log-entry {
      border-left: 3px solid var(--color-purple);
      background: var(--bg-card);
      padding: 6px 10px;
      border-radius: 0 4px 4px 0;
      margin-bottom: 4px;
    }
    .iteration-grouped { margin-left: 20px; border-left-color: var(--border-medium); }
    .log-entry-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .log-seq { font-size: 10px; color: var(--text-tertiary); min-width: 28px; }
    .log-time { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; }
    .unified-type-badge { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
    .ubadge-ai { background: var(--color-purple); color: var(--text-on-accent); }
    .meta-chip { font-size: 11px; padding: 1px 6px; border-radius: 10px; white-space: nowrap; }
    .provider-chip { background: var(--color-info-subtle); color: var(--color-info); }
    .provider-anthropic { background: var(--color-error-subtle); color: var(--color-error); }
    .provider-openai { background: var(--color-info-subtle); color: var(--color-info); }
    .provider-ollama { background: var(--color-purple-subtle); color: var(--color-purple); }
    .model-chip { background: var(--bg-muted); color: var(--text-primary); }
    .task-chip { background: var(--color-success-subtle); color: var(--color-success); }
    .token-chip { background: var(--color-warning-subtle); color: var(--color-warning); }
    .duration-chip { background: var(--color-error-subtle); color: var(--color-error); }
    .ai-usage-cost { font-size: 12px; font-weight: 600; color: var(--color-success); margin-left: 4px; }

    /* Inline prompt/response blocks */
    .inline-text-block { margin-top: 6px; }
    .inline-block-label { font-size: 10px; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 2px; }
    .inline-text-content {
      font-size: 12px;
      font-family: monospace;
      color: var(--text-primary);
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--bg-muted);
      padding: 6px 8px;
      border-radius: 4px;
      border-left: 2px solid var(--border-light);
    }

    /* More data section */
    .ai-detail-sections { padding: 4px 0 2px; }
    .ai-detail-label { font-size: 11px; font-weight: 600; color: var(--text-secondary); margin: 4px 0 2px; }
    .ai-detail-label code { font-weight: 400; background: var(--bg-muted); padding: 1px 4px; border-radius: 3px; }
    .ai-detail-block { margin-bottom: 8px; }
    .sys-prompt-toggle { text-transform: uppercase; letter-spacing: 0.3px; }
    .log-metadata { font-size: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-word; background: var(--bg-muted); padding: 8px; border-radius: 4px; margin: 4px 0; max-height: 400px; overflow-y: auto; }
  `],
})
export class AiLogEntryComponent {
  entry = input.required<UnifiedLogEntry>();
  idx = input.required<number>();
  iterationGrouped = input(false);

  promptExpanded = false;
  responseExpanded = false;
  moreDataExpanded = false;
  systemPromptExpanded = false;

  promptText(): string | null {
    return this.entry().archive?.fullPrompt ?? this.entry().promptText ?? null;
  }

  responseText(): string | null {
    return this.entry().archive?.fullResponse ?? this.entry().responseText ?? null;
  }

  systemPromptText(): string | null {
    return this.entry().archive?.systemPrompt ?? this.entry().systemPrompt ?? null;
  }

  hasMoreData(): boolean {
    const e = this.entry();
    return !!(e.promptKey || this.systemPromptText() || e.conversationMetadata || e.archive?.messageCount != null);
  }

  firstLine(text: string): string {
    return text.split('\n').find(l => l.trim().length > 0) ?? '';
  }

  isMultiline(text: string): boolean {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    return lines.length > 1;
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour12: true, hour: 'numeric', minute: '2-digit' });
  }
}
