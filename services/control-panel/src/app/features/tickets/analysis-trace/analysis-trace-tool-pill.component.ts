import { Component, input, output } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { IconComponent } from '../../../shared/components/index.js';
import type { TraceToolPill } from './analysis-trace.types.js';

@Component({
  selector: 'app-analysis-trace-tool-pill',
  standalone: true,
  imports: [CommonModule, DecimalPipe, IconComponent],
  template: `
    <button type="button" class="tool-pill" [class.tool-pill-error]="pill().isError" (click)="activate.emit(pill())">
      <app-icon [name]="pill().isError ? 'close' : 'wrench'" size="xs" />
      <code class="tool-pill-name">{{ pill().toolName }}</code>
      @if (pill().durationMs != null) {
        <span class="tool-pill-meta">{{ pill().durationMs | number }}ms</span>
      }
      @if (pill().truncated) {
        <span class="meta-chip truncated-chip">truncated</span>
      }
      @if (pill().artifactId) {
        <app-icon name="download" size="xs" class="artifact-indicator" />
      }
    </button>
  `,
  styles: [`
    .tool-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border-light);
      background: var(--bg-muted);
      color: var(--text-primary);
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      cursor: pointer;
      max-width: 100%;
    }
    .tool-pill:hover { background: var(--bg-hover); }
    .tool-pill-error { border-color: var(--color-error); color: var(--color-error); }
    .tool-pill-name { font-family: monospace; background: transparent; padding: 0; }
    .tool-pill-meta { font-size: 10px; color: var(--text-tertiary); }
    .meta-chip {
      font-size: 10px; padding: 1px 5px; border-radius: 8px;
      background: var(--color-warning-subtle); color: var(--color-warning);
    }
    .truncated-chip { background: var(--color-warning-subtle); color: var(--color-warning); }
    .artifact-indicator { color: var(--color-info); }
  `],
})
export class AnalysisTraceToolPillComponent {
  pill = input.required<TraceToolPill>();
  activate = output<TraceToolPill>();
}
