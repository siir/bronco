import { Component, input } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { IconComponent } from '../../../shared/components/index.js';
import type { ChatRunToolSummary } from './chat.types.js';

@Component({
  selector: 'app-chat-tool-summary',
  standalone: true,
  imports: [CommonModule, DecimalPipe, IconComponent],
  template: `
    @if (tools().length === 0) {
      <div class="tool-summary-empty">No tool calls recorded for this run.</div>
    } @else {
      <div class="tool-pills">
        @for (t of tools(); track t.id) {
          <span class="tool-pill">
            <span class="tool-pill-name">{{ t.tool }}</span>
            @if (t.durationMs != null) {
              <span class="tool-pill-meta">{{ t.durationMs | number }}ms</span>
            }
            @if (t.resultSize != null) {
              <span class="tool-pill-meta">{{ formatSize(t.resultSize) }}</span>
            }
            @if (t.artifactId) {
              <a class="tool-pill-download"
                 [href]="artifactUrl(t.artifactId)"
                 download
                 title="Download raw result artifact">
                <app-icon name="download" size="xs" />
              </a>
            }
          </span>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; margin-top: 6px; }
    .tool-summary-empty {
      font-size: 12px;
      color: var(--text-muted, #57606a);
      font-style: italic;
    }
    .tool-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .tool-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--surface-subtle, #f6f8fa);
      border: 1px solid var(--border-subtle, #d0d7de);
      font-size: 11px;
      line-height: 16px;
    }
    .tool-pill-name {
      font-family: var(--font-mono, monospace);
      font-weight: 500;
    }
    .tool-pill-meta {
      color: var(--text-muted, #57606a);
    }
    .tool-pill-download {
      display: inline-flex;
      align-items: center;
      color: var(--color-primary, #0969da);
      text-decoration: none;
    }
  `],
})
export class ChatToolSummaryComponent {
  tools = input<ChatRunToolSummary[]>([]);

  artifactUrl(id: string): string {
    return `/api/artifacts/${id}/download`;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}
