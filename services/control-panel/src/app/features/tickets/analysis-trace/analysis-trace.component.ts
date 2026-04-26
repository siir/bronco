import { Component, DestroyRef, inject, input, output, signal, computed, effect } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { BroncoButtonComponent, IconComponent } from '../../../shared/components/index.js';
import { TicketService, type TicketEvent, type UnifiedLogEntry, type TicketCostSummary } from '../../../core/services/ticket.service.js';
import { AnalysisTraceNodeComponent, type TraceExpandEvent } from './analysis-trace-node.component.js';
import { AnalysisTraceExpandDialogComponent, type ExpandPayload } from './analysis-trace-expand.dialog.js';
import { runMergePipeline, DEFAULT_MAX_DEPTH } from './analysis-trace.merge.js';
import type { TraceFilters } from './analysis-trace.types.js';
import { computeStrategyStamp, formatStrategyStamp } from '../analysis-strategy-stamp.js';

const PAGE_SIZE = 400;

@Component({
  selector: 'app-analysis-trace',
  standalone: true,
  imports: [CommonModule, BroncoButtonComponent, IconComponent, AnalysisTraceNodeComponent, AnalysisTraceExpandDialogComponent],
  template: `
    <div class="analysis-trace">
      <!-- Strategy stamp + cost summary -->
      <div class="strategy-strip">
        <span class="strategy-badge strategy-{{ stamp().strategy }}">{{ stampText() }}</span>
        @if (costSummary(); as cs) {
          <span class="cost-badge" title="AI cost for this ticket">{{ formatCostBadge(cs) }}</span>
        }
      </div>

      <!-- Filters -->
      <div class="filter-bar" role="group" aria-label="Trace filters">
        <button type="button" class="chip" [class.chip-active]="filters().showAi" [attr.aria-pressed]="filters().showAi" (click)="toggle('showAi')">AI calls</button>
        <button type="button" class="chip" [class.chip-active]="filters().showAppLogs" [attr.aria-pressed]="filters().showAppLogs" (click)="toggle('showAppLogs')">App logs</button>
        <button type="button" class="chip" [class.chip-active]="filters().showToolCalls" [attr.aria-pressed]="filters().showToolCalls" (click)="toggle('showToolCalls')">Tool calls</button>
        <button type="button" class="chip" [class.chip-active]="filters().errorsOnly" [attr.aria-pressed]="filters().errorsOnly" (click)="toggle('errorsOnly')">Errors only</button>
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
          <span class="depth-banner-text">
            Deep analysis tree detected ({{ maxDepthObserved() }} levels). Some rendering may be condensed.
          </span>
          <button type="button" class="depth-banner-link" (click)="viewRawLogs.emit()">
            View chronological Raw Logs
            <app-icon name="chevron-right" size="xs" />
          </button>
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
    .cost-badge {
      font-size: 12px; font-weight: 500;
      padding: 4px 10px; border-radius: 12px;
      background: var(--bg-muted); color: var(--text-secondary);
      white-space: nowrap;
    }
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
    .depth-banner-text { flex: 1; }
    .depth-banner-link {
      display: inline-flex; align-items: center; gap: 4px;
      background: transparent; border: 1px solid var(--color-warning);
      color: var(--color-warning); padding: 2px 8px; border-radius: 4px;
      font-size: 12px; cursor: pointer;
    }
    .depth-banner-link:hover { background: var(--color-warning); color: var(--text-on-accent); }
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
  /**
   * Manual-refresh fan-out token from the parent ticket-detail component.
   * Bumped after the parent's forkJoin lands; we re-run `load(ticketId)`
   * so the trace re-fetches on operator-initiated refresh. Tracked in the
   * existing constructor effect alongside `ticketId()` — no separate effect.
   */
  refreshToken = input<number>(0);

  /** Emitted when the operator clicks "View chronological Raw Logs" on the deep-tree banner. */
  viewRawLogs = output<void>();

  private ticketService = inject(TicketService);
  private destroyRef = inject(DestroyRef);

  entries = signal<UnifiedLogEntry[]>([]);
  loading = signal(false);
  costSummary = signal<TicketCostSummary | null>(null);

  /** Tracks the in-flight cost request so it can be canceled when ticketId changes. */
  private costSub: Subscription | null = null;

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
      // Track refreshToken so manual-refresh fan-out from the parent
      // re-runs load(). Initial mount already runs because ticketId() is
      // also tracked.
      this.refreshToken();
      const id = this.ticketId();
      if (id) this.load(id);
    });
  }

  // Monotonic counter for the unified-logs fetch path inside load(). Each
  // call captures the current value; out-of-order responses (e.g. from rapid
  // refreshToken bumps) are discarded if a newer request has since started.
  // The cost-summary path uses costSub.unsubscribe() instead since it's a
  // single in-flight request tracked by the subscription handle.
  private requestId = 0;

  private load(ticketId: string): void {
    const myRequestId = ++this.requestId;
    this.loading.set(true);

    // Cancel any prior in-flight cost request and clear stale data before fetching for the new ticket.
    this.costSub?.unsubscribe();
    this.costSummary.set(null);

    // Load cost summary in parallel — non-blocking, doesn't gate the trace render.
    this.costSub = this.ticketService.getCostSummary(ticketId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (cs) => {
          if (myRequestId !== this.requestId) return; // stale — discard
          this.costSummary.set(cs);
        },
        error: () => { /* non-fatal — cost badge just won't render */ },
      });

    // Unified logs are returned oldest→newest. For tickets with more than PAGE_SIZE
    // entries, the first page would miss the latest analysis run (including its
    // strategy stamp). Do an initial fetch to discover the total, then re-fetch the
    // most-recent window if the ticket exceeds the page size.
    this.ticketService.getUnifiedLogs(ticketId, { limit: PAGE_SIZE })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (myRequestId !== this.requestId) return; // stale — discard
          const total = typeof res.total === 'number' ? res.total : res.entries.length;
          const recentOffset = Math.max(0, total - PAGE_SIZE);
          if (recentOffset === 0 || res.entries.length >= total) {
            this.entries.set(res.entries);
            this.loading.set(false);
            return;
          }
          this.ticketService.getUnifiedLogs(ticketId, { limit: PAGE_SIZE, offset: recentOffset })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (recentRes) => {
                if (myRequestId !== this.requestId) return; // stale — discard
                this.entries.set(recentRes.entries);
                this.loading.set(false);
              },
              error: () => {
                if (myRequestId !== this.requestId) return;
                this.loading.set(false);
              },
            });
        },
        error: () => {
          if (myRequestId !== this.requestId) return;
          this.loading.set(false);
        },
      });
  }

  /** Format the cost badge label, e.g. "38 calls · $1.05 · 14m 48s · 174k in / 30k out". */
  formatCostBadge(cs: TicketCostSummary): string {
    const parts: string[] = [`${cs.callCount} calls`];
    if (cs.totalCostUsd > 0) parts.push(`$${cs.totalCostUsd.toFixed(2)}`);
    if (cs.wallClockMs > 0) parts.push(this.formatDuration(cs.wallClockMs));
    if (cs.totalInputTokens > 0 || cs.totalOutputTokens > 0) {
      parts.push(`${this.formatTokens(cs.totalInputTokens)} in / ${this.formatTokens(cs.totalOutputTokens)} out`);
    }
    return parts.join(' · ');
  }

  /** Format a millisecond duration as a human-readable string, e.g. "14m 48s" or "38s". */
  formatDuration(ms: number): string {
    const totalSec = Math.round(ms / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  /** Format a token count using k abbreviation for readability, e.g. "174k" or "830". */
  formatTokens(count: number): string {
    if (count >= 1000) return `${Math.round(count / 1000)}k`;
    return String(count);
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
