import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type UnifiedLogEntry } from '../../core/services/ticket.service';

@Component({
  selector: 'app-ai-log-entry',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
    <div class="ai-log-entry unified-type-ai" [class.iteration-grouped]="iterationGrouped()">
      <!-- Header row -->
      <div class="log-entry-header">
        <span class="log-seq">#{{ idx() + 1 }}</span>
        <span class="log-time" [matTooltip]="entry().timestamp">{{ formatTime(entry().timestamp) }}</span>
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
            <button mat-button class="inline-expand-btn" (click)="promptExpanded = !promptExpanded">
              {{ promptExpanded ? 'less' : 'more' }}
              <mat-icon>{{ promptExpanded ? 'keyboard_double_arrow_up' : 'keyboard_double_arrow_down' }}</mat-icon>
            </button>
          }
        </div>
      }

      <!-- Response -->
      @if (responseText()) {
        <div class="inline-text-block">
          <span class="inline-block-label">Response</span>
          <pre class="inline-text-content" [class.clamped]="!responseExpanded">{{ responseExpanded ? responseText() : firstLine(responseText()!) }}</pre>
          @if (isMultiline(responseText()!)) {
            <button mat-button class="inline-expand-btn" (click)="responseExpanded = !responseExpanded">
              {{ responseExpanded ? 'less' : 'more' }}
              <mat-icon>{{ responseExpanded ? 'keyboard_double_arrow_up' : 'keyboard_double_arrow_down' }}</mat-icon>
            </button>
          }
        </div>
      }

      <!-- More data (system prompt, prompt key, conversation metadata, archive stats) -->
      @if (hasMoreData()) {
        <button mat-button class="log-expand-btn" (click)="moreDataExpanded = !moreDataExpanded">
          {{ moreDataExpanded ? 'less data' : 'more data' }}
          <mat-icon>{{ moreDataExpanded ? 'expand_less' : 'expand_more' }}</mat-icon>
        </button>
        @if (moreDataExpanded) {
          <div class="ai-detail-sections">
            @if (entry().promptKey) {
              <div class="ai-detail-label">Prompt Key: <code>{{ entry().promptKey }}</code></div>
            }
            @if (systemPromptText()) {
              <div class="ai-detail-block">
                <button mat-button class="log-expand-btn sys-prompt-toggle" (click)="systemPromptExpanded = !systemPromptExpanded">
                  System Prompt
                  <mat-icon>{{ systemPromptExpanded ? 'expand_less' : 'expand_more' }}</mat-icon>
                </button>
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
      border-left: 3px solid #7c4dff;
      background: #fafafa;
      padding: 6px 10px;
      border-radius: 0 4px 4px 0;
      margin-bottom: 4px;
    }
    .iteration-grouped { margin-left: 20px; border-left-color: #b39ddb; }
    .log-entry-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .log-seq { font-size: 10px; color: #bbb; min-width: 28px; }
    .log-time { font-size: 11px; color: #999; white-space: nowrap; }
    .unified-type-badge { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
    .ubadge-ai { background: #7c4dff; color: white; }
    .meta-chip { font-size: 11px; padding: 1px 6px; border-radius: 10px; white-space: nowrap; }
    .provider-chip { background: #e8eaf6; color: #3949ab; }
    .provider-anthropic { background: #fce4ec; color: #c2185b; }
    .provider-openai { background: #e0f7fa; color: #00838f; }
    .provider-ollama { background: #f3e5f5; color: #7b1fa2; }
    .model-chip { background: #f5f5f5; color: #444; }
    .task-chip { background: #e8f5e9; color: #2e7d32; }
    .token-chip { background: #fff3e0; color: #e65100; }
    .duration-chip { background: #fce4ec; color: #880e4f; }
    .ai-usage-cost { font-size: 12px; font-weight: 600; color: #2e7d32; margin-left: 4px; }

    /* Inline prompt/response blocks */
    .inline-text-block { margin-top: 6px; }
    .inline-block-label { font-size: 10px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 2px; }
    .inline-text-content {
      font-size: 12px;
      font-family: monospace;
      color: #333;
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: #f7f7f7;
      padding: 6px 8px;
      border-radius: 4px;
      border-left: 2px solid #e0e0e0;
    }
    .inline-expand-btn {
      font-size: 11px;
      min-height: 22px;
      color: #666;
      padding: 0 4px;
      display: inline-flex;
      align-items: center;
    }
    .inline-expand-btn mat-icon { font-size: 14px; width: 14px; height: 14px; }

    /* More data section */
    .log-expand-btn { font-size: 11px; min-height: 24px; color: #888; padding: 0 4px; }
    .ai-detail-sections { padding: 4px 0 2px; }
    .ai-detail-label { font-size: 11px; font-weight: 600; color: #666; margin: 4px 0 2px; }
    .ai-detail-label code { font-weight: 400; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
    .ai-detail-block { margin-bottom: 8px; }
    .sys-prompt-toggle { min-height: 24px; font-size: 11px; font-weight: 600; color: #666; padding: 0 4px; text-transform: uppercase; letter-spacing: 0.3px; }
    .log-metadata { font-size: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-word; background: #f5f5f5; padding: 8px; border-radius: 4px; margin: 4px 0; max-height: 400px; overflow-y: auto; }
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
