import { Component, effect, input, output, signal } from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe } from '@angular/common';
import { BroncoButtonComponent, IconComponent } from '../../../shared/components/index.js';
import { AnalysisTraceToolPillComponent } from './analysis-trace-tool-pill.component.js';
import { firstUserMessageText, effectivePrimaryResponse } from './analysis-trace.merge.js';
import type { TraceFilters, TraceNode, TraceToolPill } from './analysis-trace.types.js';

/** Event emitted when the user clicks a card or tool pill. */
export interface TraceExpandEvent {
  kind: 'node' | 'pill';
  node?: TraceNode;
  pill?: TraceToolPill;
}

@Component({
  selector: 'app-analysis-trace-node',
  standalone: true,
  imports: [CommonModule, DatePipe, DecimalPipe, BroncoButtonComponent, IconComponent, AnalysisTraceToolPillComponent],
  template: `
    @let n = node();
    @if (isVisible(n)) {
      <div class="trace-node" [class.trace-node-error]="isError(n)" [style.margin-left.px]="n.depth * 18">
        @if (n.entry.type === 'ai') {
          <div class="trace-card trace-card-ai" (click)="expand.emit({ kind: 'node', node: n })">
            <div class="trace-header">
              <span class="meta-chip task-chip">{{ n.entry.taskType }}</span>
              @if (n.entry.model) { <code class="meta-chip model-chip">{{ n.entry.model }}</code> }
              @if (n.entry.inputTokens != null) {
                <span class="meta-chip token-chip">{{ n.entry.inputTokens | number }}in / {{ n.entry.outputTokens | number }}out</span>
              }
              @if (n.entry.durationMs != null) {
                <span class="meta-chip duration-chip">{{ n.entry.durationMs | number }}ms</span>
              }
              @if (n.entry.costUsd != null) {
                <span class="trace-cost">\${{ n.entry.costUsd | number:'1.4-4' }}</span>
              }
              @if (n.continuations.length > 0) {
                <span class="meta-chip cont-chip">+{{ n.continuations.length }} continuation{{ n.continuations.length === 1 ? '' : 's' }}</span>
              }
              @if (isTruncated(n)) { <span class="meta-chip truncated-chip">truncated</span> }
              <span class="trace-time">{{ n.entry.timestamp | date:'shortTime' }}</span>
            </div>
            <div class="trace-oneliner">
              <span class="trace-preview-label">Prompt:</span>
              <span class="trace-preview">{{ firstLine(promptText(n)) }}</span>
            </div>
            @if (respLine(n); as r) {
              <div class="trace-oneliner">
                <span class="trace-preview-label">→</span>
                <span class="trace-preview">{{ r }}</span>
              </div>
            }
            @if (n.toolPills.length > 0 && filters().showToolCalls) {
              <div class="trace-pills" (click)="$event.stopPropagation()">
                @for (pill of n.toolPills; track pill.id) {
                  <app-analysis-trace-tool-pill [pill]="pill" (activate)="expand.emit({ kind: 'pill', pill })" />
                }
              </div>
            }
          </div>
        } @else if (n.entry.type === 'log' || n.entry.type === 'step') {
          <div class="trace-card trace-card-log" (click)="expand.emit({ kind: 'node', node: n })">
            <app-icon name="pending" size="xs" />
            <span class="trace-msg">{{ n.entry.message }}</span>
            @if (n.entry.durationMs != null) { <span class="meta-chip duration-chip">{{ n.entry.durationMs | number }}ms</span> }
          </div>
        } @else if (n.entry.type === 'error') {
          <div class="trace-card trace-card-error" (click)="expand.emit({ kind: 'node', node: n })">
            <app-icon name="close" size="xs" />
            <span class="trace-msg">{{ n.entry.message }}</span>
          </div>
        } @else if (n.entry.type === 'tool') {
          <div class="trace-card trace-card-tool" (click)="expand.emit({ kind: 'node', node: n })">
            <app-icon name="wrench" size="xs" />
            <span class="trace-msg">{{ n.entry.message }}</span>
            @if (n.entry.durationMs != null) { <span class="meta-chip duration-chip">{{ n.entry.durationMs | number }}ms</span> }
          </div>
        }
      </div>
    }

    @if (!n.condensed || condensedExpanded()) {
      @for (child of n.children; track child.id) {
        <app-analysis-trace-node
          [node]="child"
          [filters]="filters()"
          [collapseAllToken]="collapseAllToken()"
          [expandAllToken]="expandAllToken()"
          (expand)="expand.emit($event)" />
      }
    }

    @if (n.condensed && n.condensed.length > 0) {
      <div class="condensed-stub" [style.margin-left.px]="(n.depth + 1) * 18">
        <app-bronco-button variant="ghost" size="sm" (click)="toggleCondensed()">
          {{ condensedExpanded() ? 'Hide' : 'Expand inline' }} · {{ n.condensed.length }} deeper node{{ n.condensed.length === 1 ? '' : 's' }}
          <app-icon [name]="condensedExpanded() ? 'chevron-up' : 'chevron-down'" size="xs" />
        </app-bronco-button>
      </div>
      @if (condensedExpanded()) {
        @for (child of n.condensed; track child.id) {
          <app-analysis-trace-node
            [node]="child"
            [filters]="filters()"
            [collapseAllToken]="collapseAllToken()"
            [expandAllToken]="expandAllToken()"
            (expand)="expand.emit($event)" />
        }
      }
    }
  `,
  styles: [`
    .trace-node { margin-bottom: 6px; }
    .trace-card {
      padding: 6px 10px;
      border-radius: 4px;
      border-left: 3px solid var(--color-purple);
      background: var(--bg-card);
      cursor: pointer;
    }
    .trace-card-ai { border-left-color: var(--color-purple); }
    .trace-card-log { border-left-color: var(--border-medium); display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
    .trace-card-tool { border-left-color: var(--color-info); display: flex; align-items: center; gap: 6px; font-size: 12px; }
    .trace-card-error { border-left-color: var(--color-error); display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-error); }
    .trace-node-error .trace-card-ai { border-left-color: var(--color-error); }
    .trace-card:hover { background: var(--bg-hover); }
    .trace-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .trace-cost { font-size: 12px; font-weight: 600; color: var(--color-success); margin-left: 2px; }
    .trace-time { margin-left: auto; font-size: 10px; color: var(--text-tertiary); }
    .trace-oneliner {
      display: flex; gap: 6px; align-items: baseline; font-size: 12px;
      margin-top: 4px; color: var(--text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .trace-preview-label { font-size: 10px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; min-width: 48px; }
    .trace-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; flex: 1; }
    .trace-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .meta-chip { font-size: 11px; padding: 1px 6px; border-radius: 10px; background: var(--bg-muted); color: var(--text-primary); white-space: nowrap; }
    .task-chip { background: var(--color-success-subtle); color: var(--color-success); }
    .model-chip { font-family: monospace; background: var(--bg-muted); }
    .token-chip { background: var(--color-warning-subtle); color: var(--color-warning); }
    .duration-chip { background: var(--color-error-subtle); color: var(--color-error); }
    .cont-chip { background: var(--color-info-subtle); color: var(--color-info); }
    .truncated-chip { background: var(--color-warning-subtle); color: var(--color-warning); }
    .trace-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .condensed-stub { margin-top: 2px; margin-bottom: 4px; }
  `],
})
export class AnalysisTraceNodeComponent {
  node = input.required<TraceNode>();
  filters = input.required<TraceFilters>();
  collapseAllToken = input<number>(0);
  expandAllToken = input<number>(0);

  expand = output<TraceExpandEvent>();

  condensedExpanded = signal(false);

  constructor() {
    // Parent issues "collapse all" by incrementing `collapseAllToken`; react by
    // collapsing the condensed subtree regardless of prior state. Same for expand.
    // Using effects keeps the wiring declarative and covers nested nodes.
    let prevCollapse = this.collapseAllToken();
    effect(() => {
      const v = this.collapseAllToken();
      if (v !== prevCollapse) {
        prevCollapse = v;
        this.condensedExpanded.set(false);
      }
    });
    let prevExpand = this.expandAllToken();
    effect(() => {
      const v = this.expandAllToken();
      if (v !== prevExpand) {
        prevExpand = v;
        this.condensedExpanded.set(true);
      }
    });
  }

  toggleCondensed(): void {
    this.condensedExpanded.update(v => !v);
  }

  isVisible(n: TraceNode): boolean {
    const f = this.filters();
    if (f.errorsOnly && !this.isError(n)) return false;
    if (n.entry.type === 'ai' && !f.showAi) return false;
    if (n.entry.type === 'log' && !f.showAppLogs) return false;
    if (n.entry.type === 'tool' && !f.showToolCalls) return false;
    if (n.entry.type === 'step' && !f.showAppLogs) return false;
    return true;
  }

  isError(n: TraceNode): boolean {
    if (n.entry.type === 'error') return true;
    if (n.entry.error) return true;
    const ctx = (n.entry.context ?? {}) as Record<string, unknown>;
    return !!ctx['isError'];
  }

  isTruncated(n: TraceNode): boolean {
    const meta = (n.entry.conversationMetadata ?? {}) as Record<string, unknown>;
    if (meta['truncated'] === true) return true;
    return n.toolPills.some(p => p.truncated);
  }

  promptText(n: TraceNode): string {
    return firstUserMessageText(n.entry) ?? '';
  }

  respLine(n: TraceNode): string | null {
    const r = effectivePrimaryResponse(n);
    if (!r.trim()) return null;
    return this.firstLine(r);
  }

  firstLine(text: string): string {
    if (!text) return '';
    const line = text.split('\n').find(l => l.trim().length > 0) ?? '';
    return line.length > 220 ? line.slice(0, 220) + '…' : line;
  }
}
