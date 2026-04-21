import { Component, DestroyRef, inject, input, signal, computed, effect } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { BroncoButtonComponent, IconComponent } from '../../../shared/components/index.js';
import { TicketService, type TicketEvent, type UnifiedLogEntry } from '../../../core/services/ticket.service.js';
import { AnalysisTraceNodeComponent, type TraceExpandEvent } from './analysis-trace-node.component.js';
import { AnalysisTraceExpandDialogComponent, type ExpandPayload } from './analysis-trace-expand.dialog.js';
import { runMergePipeline, DEFAULT_MAX_DEPTH } from './analysis-trace.merge.js';
import type { TraceFilters } from './analysis-trace.types.js';
import { computeStrategyStamp, formatStrategyStamp } from '../analysis-strategy-stamp.js';

@Component({
  selector: 'app-analysis-trace',
  standalone: true,
  imports: [CommonModule, BroncoButtonComponent, IconComponent, AnalysisTraceNodeComponent, AnalysisTraceExpandDialogComponent],
  template: `
    <div class="analysis-trace">
      <!-- Strategy stamp -->
      <div class="strategy-strip">
        <span class="strategy-badge strategy-{{ stamp().strategy }}">{{ stampText() }}</span>
      </div>

      <!-- Filters -->
      <div class="filter-bar">
        <button type="button" class="chip" [class.chip-active]="filters().showAi" (click)="toggle('showAi')">AI calls</button>
        <button type="button" class="chip" [class.chip-active]="filters().showAppLogs" (click)="toggle('showAppLogs')">App logs</button>
        <button type="button" class="chip" [class.chip-active]="filters().showToolCalls" (click)="toggle('showToolCalls')">Tool calls</button>
        <button type="button" class="chip" [class.chip-active]="filters().errorsOnly" (click)="toggle('errorsOnly')">Errors only</button>
        <span class="filter-spacer"></span>
        <app-bronco-button variant="ghost" size="sm" (click)="collapseAll()">Collapse all</app-bronco-button>
        <app-bronco-button variant="ghost" size="sm" (click)="expandAll()">Expand all</app-bronco-button>
        <label class="debug-toggle">
          <input type="checkbox" [checked]="debugUnmerged()" (change)="toggleDebug($event)" />
          Show unmerged tree
        </label>
      </div>

      @if (maxDepthObserved() > DEFAULT_MAX_DEPTH) {
        <div class="depth-banner">
          <app-icon name="chevron-down" size="xs" />
          Deep analysis tree detected ({{ maxDepthObserved() }} levels). Some rendering may be condensed.
        </div>
      }

      @if (loading()) {
        <div class="indeterminate-bar"><span class="indeterminate-track"></span></div>
      } @else if (entries().length === 0) {
        <p class="empty">No AI activity recorded for this ticket.</p>
      } @else {
        <div class="trace-list">
          @for (root of merged().roots; track root.id) {
            <app-analysis-trace-node
              [node]="root"
              [filters]="filters()"
              [collapseAllToken]="collapseAllToken()"
              [expandAllToken]="expandAllToken()"
              (expand)="onExpand($event)" />
          }
        </div>
      }

      @if (expandPayload(); as p) {
        <app-analysis-trace-expand-dialog [payload]="p" (closed)="expandPayload.set(null)" />
      }
    </div>
  `,
  styles: [`
    .analysis-trace { display: flex; flex-direction: column; gap: 10px; }
    .strategy-strip { display: flex; gap: 6px; }
    .strategy-badge {
      font-size: 12px; font-weight: 600;
      padding: 4px 10px; border-radius: 12px;
      background: var(--bg-muted); color: var(--text-primary);
    }
    .strategy-flat { background: var(--color-info-subtle); color: var(--color-info); }
    .strategy-orchestrated { background: var(--color-success-subtle); color: var(--color-success); }
    .strategy-legacy { background: var(--bg-muted); color: var(--text-tertiary); }
    .filter-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .filter-spacer { flex: 1; }
    .chip {
      background: var(--bg-muted); color: var(--text-secondary);
      border: 1px solid var(--border-light);
      padding: 3px 10px; border-radius: 14px; font-size: 12px; cursor: pointer;
    }
    .chip-active { background: var(--color-purple-subtle); color: var(--color-purple); border-color: var(--color-purple); }
    .debug-toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-secondary); margin-left: 10px; }
    .depth-banner {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-radius: 4px;
      background: var(--color-warning-subtle); color: var(--color-warning);
      font-size: 12px;
    }
    .trace-list { display: flex; flex-direction: column; gap: 2px; }
    .empty { color: var(--text-tertiary); font-style: italic; font-size: 13px; }
    .indeterminate-bar { height: 2px; background: var(--bg-muted); overflow: hidden; }
    .indeterminate-track { display: block; height: 100%; background: var(--color-purple); animation: indet 1.2s infinite linear; }
    @keyframes indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }
  `],
})
export class AnalysisTraceComponent {
  readonly DEFAULT_MAX_DEPTH = DEFAULT_MAX_DEPTH;

  ticketId = input.required<string>();
  /** Parent-provided ticket events (used for strategy fallback). Optional. */
  events = input<TicketEvent[]>([]);

  private ticketService = inject(TicketService);
  private destroyRef = inject(DestroyRef);

  entries = signal<UnifiedLogEntry[]>([]);
  loading = signal(false);

  filters = signal<TraceFilters>({
    showAi: true,
    showAppLogs: true,
    showToolCalls: true,
    errorsOnly: false,
  });
  debugUnmerged = signal(false);
  collapseAllToken = signal(0);
  expandAllToken = signal(0);

  expandPayload = signal<ExpandPayload | null>(null);

  merged = computed(() => {
    return runMergePipeline(this.entries(), { debugUnmerged: this.debugUnmerged() });
  });
  maxDepthObserved = computed(() => this.merged().maxDepth);

  stamp = computed(() => computeStrategyStamp(this.entries(), this.events()));
  stampText = computed(() => formatStrategyStamp(this.stamp()));

  constructor() {
    effect(() => {
      const id = this.ticketId();
      if (id) this.load(id);
    });
  }

  private load(ticketId: string): void {
    this.loading.set(true);
    this.ticketService.getUnifiedLogs(ticketId, { limit: 400 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.entries.set(res.entries);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  toggle(field: keyof TraceFilters): void {
    this.filters.update(f => ({ ...f, [field]: !f[field] }));
  }

  toggleDebug(ev: Event): void {
    this.debugUnmerged.set((ev.target as HTMLInputElement).checked);
  }

  collapseAll(): void {
    this.collapseAllToken.update(v => v + 1);
  }

  expandAll(): void {
    this.expandAllToken.update(v => v + 1);
  }

  onExpand(event: TraceExpandEvent): void {
    this.expandPayload.set(event);
  }
}
