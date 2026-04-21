import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { ChatRunMeta } from './chat.types.js';
import { formatRunStrategyLabel } from './chat.types.js';

@Component({
  selector: 'app-chat-run-marker',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="run-marker" [attr.id]="'run-' + run().runNumber">
      <span class="run-marker-rule"></span>
      <span class="run-marker-label">
        <span class="run-marker-index">Run {{ run().runNumber }}</span>
        <span class="run-marker-sep">·</span>
        <span class="run-marker-strategy" [class.mismatch]="isMismatch()">{{ strategyLabel() }}</span>
        @if (modelsLabel()) {
          <span class="run-marker-sep">·</span>
          <span class="run-marker-model">{{ modelsLabel() }}</span>
        }
        @if (durationLabel()) {
          <span class="run-marker-sep">·</span>
          <span class="run-marker-duration">{{ durationLabel() }}</span>
        }
        <span class="run-marker-sep">·</span>
        <span class="run-marker-tools">{{ run().toolCount }} tool{{ run().toolCount === 1 ? '' : 's' }}</span>
        @if (run().mode) {
          <span class="run-marker-sep">·</span>
          <span class="run-marker-mode">{{ run().mode }}</span>
        }
      </span>
      <span class="run-marker-rule"></span>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .run-marker {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 16px 0 8px;
      scroll-margin-top: 72px;
    }
    .run-marker-rule {
      flex: 1;
      height: 1px;
      background: var(--border-subtle, #d0d7de);
    }
    .run-marker-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px;
      font-size: 11px;
      color: var(--text-muted, #57606a);
      background: var(--surface-subtle, #f6f8fa);
      border-radius: 999px;
      border: 1px solid var(--border-subtle, #d0d7de);
      white-space: nowrap;
    }
    .run-marker-index { font-weight: 600; color: var(--text-default, #24292f); }
    .run-marker-strategy.mismatch { color: var(--color-warning, #9a6700); font-weight: 500; }
    .run-marker-model {
      font-family: var(--font-mono, monospace);
    }
    .run-marker-sep { color: var(--border-default, #afb8c1); }
  `],
})
export class ChatRunMarkerComponent {
  run = input.required<ChatRunMeta>();
  /** Ticket's configured strategy — for mismatch detection. */
  configuredStrategy = input<'flat' | 'orchestrated' | null>(null);

  strategyLabel = computed(() => formatRunStrategyLabel(this.run().actualStrategy, this.configuredStrategy()));
  isMismatch = computed(() => {
    const cfg = this.configuredStrategy();
    return !!cfg && this.run().actualStrategy !== 'legacy' && this.run().actualStrategy !== cfg;
  });
  modelsLabel = computed(() => this.run().models.join(', '));
  durationLabel = computed(() => {
    const d = this.run().durationMs;
    if (d == null) return '';
    if (d < 1000) return `${d}ms`;
    if (d < 60_000) return `${(d / 1000).toFixed(1)}s`;
    return `${(d / 60_000).toFixed(1)}m`;
  });
}
