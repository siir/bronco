import {
  AfterViewChecked,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  TicketService,
  type TicketEvent,
  type UnifiedLogEntry,
} from '../../../core/services/ticket.service.js';
import { ApiService } from '../../../core/services/api.service.js';
import { ToastService } from '../../../core/services/toast.service.js';
import { BroncoButtonComponent, IconComponent } from '../../../shared/components/index.js';
import { ChatMessageComponent } from './chat-message.component.js';
import { ChatRunMarkerComponent } from './chat-run-marker.component.js';
import {
  ChatReplyInputComponent,
  type ChatReplyModeSelection,
  type ChatReplySubmit,
} from './chat-reply-input.component.js';
import {
  ChatNewAnalysisDialogComponent,
  type ChatNewAnalysisSubmit,
} from './chat-new-analysis.dialog.js';
import {
  CHAT_REANALYSIS_MODES,
  deriveRunMeta,
  type ChatClassifiedIntent,
  type ChatIntentLabel,
  type ChatMessageResponse,
  type ChatPickModeResponse,
  type ChatReanalysisMode,
  type ChatRunMeta,
  type ChatThreadItem,
  type TicketAnalysisStrategyResponse,
} from './chat.types.js';

interface ThreadNode {
  kind: 'item' | 'run-marker';
  item?: ChatThreadItem;
  run?: ChatRunMeta;
}

@Component({
  selector: 'app-chat-tab',
  standalone: true,
  imports: [
    CommonModule,
    BroncoButtonComponent,
    IconComponent,
    ChatMessageComponent,
    ChatRunMarkerComponent,
    ChatReplyInputComponent,
    ChatNewAnalysisDialogComponent,
  ],
  template: `
    <div class="chat-tab">
      <div class="chat-toolbar">
        <div class="bookmarks">
          @if (runs().length > 0) {
            <span class="bookmarks-label">Runs:</span>
            @for (r of bookmarkRuns(); track r.runNumber) {
              <button
                type="button"
                class="bookmark-chip"
                (click)="scrollToRun(r.runNumber)">
                Run {{ r.runNumber }}
              </button>
            }
            @if (hiddenOlderRunCount() > 0) {
              <button type="button" class="bookmark-more" (click)="toggleShowAllRuns()">
                {{ showAllRuns() ? 'Hide' : 'Show' }} {{ hiddenOlderRunCount() }} older
              </button>
            }
          }
        </div>
        <div class="toolbar-actions">
          <app-bronco-button variant="secondary" size="sm" (click)="openNewAnalysisDialog()">
            <app-icon name="refresh" size="xs" /> New analysis run
          </app-bronco-button>
        </div>
      </div>

      <div #scrollArea class="chat-scroll" (scroll)="onScroll()">
        @if (threadNodes().length === 0 && !loading()) {
          <div class="chat-empty">No messages yet for this ticket.</div>
        }
        @for (n of threadNodes(); track trackNode($index, n)) {
          @if (n.kind === 'run-marker' && n.run) {
            <app-chat-run-marker
              [run]="n.run"
              [configuredStrategy]="configuredStrategy()" />
          } @else if (n.kind === 'item' && n.item) {
            <app-chat-message
              [item]="n.item"
              [run]="runForItem(n.item)"
              [modePickInFlight]="modePickInFlight() === n.item.id"
              (pickMode)="pickMode(n.item!, $event)"
              (viewInTrace)="viewInTrace.emit($event)" />
          }
        }
      </div>

      @if (showJumpLatest()) {
        <button type="button" class="jump-latest" (click)="scrollToBottom(true)">
          <app-icon name="arrow-down" size="xs" /> Jump to latest
        </button>
      }

      <app-chat-reply-input
        #replyInput
        (submit)="onReplySubmit($event)" />

      <app-chat-new-analysis-dialog
        [open]="newAnalysisOpen()"
        (submitted)="onNewAnalysisSubmit($event)"
        (cancel)="closeNewAnalysisDialog()" />
    </div>
  `,
  styles: [`
    :host { display: block; }
    .chat-tab {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 320px);
      min-height: 480px;
      position: relative;
      border: 1px solid var(--border-subtle, #d0d7de);
      border-radius: var(--radius-md, 8px);
      background: var(--bg-muted, #f6f8fa);
      overflow: hidden;
    }
    .chat-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 12px;
      background: var(--surface-default, #ffffff);
      border-bottom: 1px solid var(--border-subtle, #d0d7de);
    }
    .bookmarks {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      min-height: 24px;
    }
    .bookmarks-label {
      font-size: 11px;
      color: var(--text-muted, #57606a);
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .bookmark-chip, .bookmark-more {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--surface-subtle, #f6f8fa);
      border: 1px solid var(--border-subtle, #d0d7de);
      color: var(--text-muted, #57606a);
      cursor: pointer;
    }
    .bookmark-chip:hover, .bookmark-more:hover {
      color: var(--text-default, #24292f);
      background: var(--bg-hover, #f0f3f6);
    }
    .bookmark-more {
      border-style: dashed;
    }
    .chat-scroll {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 16px;
      scroll-behavior: smooth;
    }
    .chat-empty {
      text-align: center;
      color: var(--text-muted, #57606a);
      padding: 32px 16px;
      font-size: 13px;
    }
    .jump-latest {
      position: absolute;
      right: 16px;
      bottom: 96px;
      background: var(--accent, #0969da);
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      box-shadow: 0 2px 6px rgba(27, 31, 36, 0.15);
    }
    .jump-latest:hover {
      background: var(--accent-hover, #0550ae);
    }
  `],
})
export class ChatTabComponent implements OnInit, AfterViewChecked {
  ticketId = input.required<string>();
  events = input.required<TicketEvent[]>();

  viewInTrace = output<string>();

  private ticketService = inject(TicketService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  private scrollArea = viewChild<ElementRef<HTMLDivElement>>('scrollArea');
  private replyInput = viewChild<ChatReplyInputComponent>('replyInput');

  /** Unified logs joined into run-scoped tool summaries. */
  private unifiedLogs = signal<UnifiedLogEntry[]>([]);
  loading = signal(false);

  /** Ticket's configured strategy for mismatch highlighting. */
  configuredStrategy = signal<'flat' | 'orchestrated' | null>(null);

  /** True while an outbound chat-send is in flight (disables reply input). */
  sending = signal(false);

  /** Item ID currently awaiting pick-mode server response. */
  modePickInFlight = signal<string | null>(null);

  /** Optimistic placeholder item injected before server response. */
  private optimisticItems = signal<ChatThreadItem[]>([]);

  /** Mode-pick overrides (eventId → picked mode) applied client-side. */
  private modePickOverrides = signal<Record<string, ChatIntentLabel>>({});

  /** "Analyzing…" placeholder id shown after a classified intent triggers a run. */
  private analyzingPlaceholderId = signal<string | null>(null);

  /** Client-side toggle: show older runs that were collapsed by default. */
  showAllRuns = signal(false);

  newAnalysisOpen = signal(false);

  /** Whether the user is scrolled away from the bottom (for "Jump to latest"). */
  showJumpLatest = signal(false);

  /** Pending bookmark scroll target — applied once the DOM renders. */
  private pendingScrollRun = signal<number | null>(null);

  /** Set once we've performed the initial auto-scroll to bottom. */
  private initialScrollDone = false;

  /** Combined thread items (from events + optimistic), in chronological order. */
  allItems = computed<ChatThreadItem[]>(() => {
    const evts = [...this.events()].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const items: ChatThreadItem[] = [];
    const overrides = this.modePickOverrides();

    for (const e of evts) {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;

      if (e.eventType === 'EMAIL_INBOUND') {
        const fromName =
          (meta['fromName'] as string) ?? (meta['from'] as string) ?? 'Requester';
        items.push({
          id: e.id,
          role: 'user',
          kind: 'email_inbound',
          authorLabel: fromName,
          timestamp: e.createdAt,
          body: e.content ?? '',
          event: e,
        });
        continue;
      }

      if (e.eventType === 'CHAT_MESSAGE') {
        const authorLabel = (meta['authorLabel'] as string) ?? 'Operator';
        const classifiedRaw = meta['classifiedIntent'] as Record<string, unknown> | undefined;
        const classifiedIntent: ChatClassifiedIntent | undefined = classifiedRaw
          ? {
              label: classifiedRaw['label'] as ChatIntentLabel,
              confidence: Number(classifiedRaw['confidence'] ?? 0),
            }
          : undefined;
        const pickedMode =
          overrides[e.id] ??
          (typeof meta['pickedMode'] === 'string'
            ? (meta['pickedMode'] as ChatIntentLabel)
            : undefined);
        const needsModePick = meta['needsModePick'] === true && !pickedMode;
        items.push({
          id: e.id,
          role: 'user',
          kind: 'chat_message',
          authorLabel,
          timestamp: e.createdAt,
          body: e.content ?? '',
          event: e,
          classifiedIntent,
          needsModePick,
          pickedMode,
        });
        continue;
      }

      if (e.eventType === 'AI_ANALYSIS') {
        const phase = typeof meta['phase'] === 'string' ? (meta['phase'] as string) : null;
        // Skip triage — too noisy for a conversational view.
        if (phase === 'triage') continue;
        items.push({
          id: e.id,
          role: 'assistant',
          kind: 'analysis',
          authorLabel: 'Bronco',
          timestamp: e.createdAt,
          body: e.content ?? '',
          event: e,
        });
        continue;
      }

      if (e.eventType === 'STATUS_CHANGE') {
        const newStatus = (meta['newStatus'] as string) ?? '';
        const oldStatus = (meta['oldStatus'] as string) ?? '';
        items.push({
          id: e.id,
          role: 'system',
          kind: 'status_change',
          authorLabel: 'System',
          timestamp: e.createdAt,
          body:
            oldStatus && newStatus
              ? `Status: ${oldStatus} → ${newStatus}`
              : `Status changed to ${newStatus || '?'}`,
          event: e,
        });
        continue;
      }
    }

    // Append optimistic items (they sit at the very end since they are in-flight).
    for (const opt of this.optimisticItems()) {
      items.push(opt);
    }

    return items;
  });

  /** Analysis runs in chronological order. */
  runs = computed<ChatRunMeta[]>(() => {
    const evts = this.events()
      .filter((e) => {
        if (e.eventType !== 'AI_ANALYSIS') return false;
        const phase = (e.metadata as Record<string, unknown> | null)?.['phase'];
        return phase !== 'triage';
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const logs = this.unifiedLogs();
    return evts.map((e, idx) => deriveRunMeta(e, idx + 1, logs));
  });

  /** Map from AI_ANALYSIS event id → its run metadata (for fast lookup by the child bubble). */
  runsByEventId = computed<Record<string, ChatRunMeta>>(() => {
    const map: Record<string, ChatRunMeta> = {};
    for (const r of this.runs()) map[r.eventId] = r;
    return map;
  });

  /** Whether older runs should be collapsed. */
  readonly OLDER_RUN_COLLAPSE_THRESHOLD = 5;

  hiddenOlderRunCount = computed(() => {
    const total = this.runs().length;
    if (this.showAllRuns()) return 0;
    return Math.max(0, total - this.OLDER_RUN_COLLAPSE_THRESHOLD);
  });

  bookmarkRuns = computed<ChatRunMeta[]>(() => {
    const all = this.runs();
    if (this.showAllRuns() || all.length <= this.OLDER_RUN_COLLAPSE_THRESHOLD) return all;
    return all.slice(-this.OLDER_RUN_COLLAPSE_THRESHOLD);
  });

  /** Final render: interleave items + run markers. */
  threadNodes = computed<ThreadNode[]>(() => {
    const items = this.allItems();
    const runs = this.runs();
    const hideCount = this.hiddenOlderRunCount();
    const visibleRunStartIdx = hideCount;
    const firstVisibleRun = runs[visibleRunStartIdx];

    // Filter items: if we're collapsing older runs, drop items whose timestamp is
    // before the first visible run (and that aren't email_inbound — we always keep that).
    const nodes: ThreadNode[] = [];
    const cutoffTs = firstVisibleRun ? new Date(firstVisibleRun.timestamp).getTime() : null;

    for (const item of items) {
      // Keep the original inbound email always as context.
      if (item.kind !== 'email_inbound' && cutoffTs != null) {
        const itemTs = new Date(item.timestamp).getTime();
        // Drop non-visible prior-run analyses + status changes.
        if (itemTs < cutoffTs && item.kind === 'analysis') continue;
      }

      // If this item is an analysis and matches a run, emit the run marker first.
      if (item.kind === 'analysis') {
        const run = this.runsByEventId()[item.id];
        if (run) {
          const shown = runs.indexOf(run) >= visibleRunStartIdx;
          if (shown) nodes.push({ kind: 'run-marker', run });
        }
      }
      nodes.push({ kind: 'item', item });
    }

    return nodes;
  });

  constructor() {
    // Clear the "Analyzing…" placeholder once the corresponding run lands.
    // Watches runs(); when a run arrives whose timestamp is newer than the
    // most recent placeholder's, we remove the placeholder and drop the id.
    effect(() => {
      const placeholderId = this.analyzingPlaceholderId();
      if (!placeholderId) return;
      const placeholder = this.optimisticItems().find((it) => it.id === placeholderId);
      if (!placeholder) {
        // Someone else already removed it — just clear the tracked id.
        this.analyzingPlaceholderId.set(null);
        return;
      }
      const placeholderTs = new Date(placeholder.timestamp).getTime();
      const latestRun = this.runs().at(-1);
      if (latestRun && new Date(latestRun.timestamp).getTime() > placeholderTs) {
        this.optimisticItems.update((items) => items.filter((it) => it.id !== placeholderId));
        this.analyzingPlaceholderId.set(null);
      }
    });
  }

  ngOnInit(): void {
    this.loadUnifiedLogs();
    this.loadConfiguredStrategy();

    // Deep-link: ?chatRun=N → scroll to run N once rendered.
    const runParam = this.route.snapshot.queryParamMap.get('chatRun');
    if (runParam) {
      const n = Number(runParam);
      if (Number.isFinite(n) && n > 0) this.pendingScrollRun.set(n);
    }
  }

  ngAfterViewChecked(): void {
    // Apply pending scroll target (bookmark nav or deep-link).
    const target = this.pendingScrollRun();
    if (target != null) {
      const anchor = this.scrollArea()?.nativeElement.querySelector<HTMLElement>(`#run-${target}`);
      if (anchor) {
        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this.pendingScrollRun.set(null);
      }
      return;
    }
    // Initial auto-scroll to bottom once the first batch of messages lands.
    if (!this.initialScrollDone && this.threadNodes().length > 0) {
      this.initialScrollDone = true;
      this.scrollToBottom(false);
    }
  }

  private loadUnifiedLogs(): void {
    this.loading.set(true);
    this.ticketService
      .getUnifiedLogs(this.ticketId(), { limit: 500 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.unifiedLogs.set(res.entries);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  private loadConfiguredStrategy(): void {
    this.api
      .get<TicketAnalysisStrategyResponse>(`/settings/analysis-strategy/${this.ticketId()}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => this.configuredStrategy.set(res.configured),
        error: () => this.configuredStrategy.set(null),
      });
  }

  runForItem(item: ChatThreadItem): ChatRunMeta | null {
    if (item.kind !== 'analysis') return null;
    return this.runsByEventId()[item.id] ?? null;
  }

  trackNode(index: number, n: ThreadNode): string {
    if (n.kind === 'run-marker') return `rm-${n.run!.runNumber}`;
    return `it-${n.item!.id}`;
  }

  scrollToRun(runNumber: number): void {
    this.pendingScrollRun.set(runNumber);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { chatRun: runNumber },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  toggleShowAllRuns(): void {
    this.showAllRuns.update((v) => !v);
  }

  openNewAnalysisDialog(): void {
    this.newAnalysisOpen.set(true);
  }

  closeNewAnalysisDialog(): void {
    this.newAnalysisOpen.set(false);
  }

  onScroll(): void {
    const el = this.scrollArea()?.nativeElement;
    if (!el) return;
    const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < 120;
    this.showJumpLatest.set(!nearBottom);
  }

  scrollToBottom(smooth: boolean): void {
    const el = this.scrollArea()?.nativeElement;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  onReplySubmit(submission: ChatReplySubmit): void {
    this.sendChatMessage(submission.text, submission.mode);
  }

  onNewAnalysisSubmit(submission: ChatNewAnalysisSubmit): void {
    this.sendChatMessage(submission.text, submission.mode, { fromDialog: true });
  }

  private sendChatMessage(
    text: string,
    mode: ChatReplyModeSelection,
    opts: { fromDialog?: boolean } = {},
  ): void {
    if (this.sending()) return;
    this.sending.set(true);
    this.replyInput()?.setDisabled(true);

    const optimisticId = `optimistic-${Date.now()}`;
    const modeOverride = mode === 'auto' ? undefined : mode;
    this.optimisticItems.update((items) => [
      ...items,
      {
        id: optimisticId,
        role: 'user',
        kind: 'chat_message',
        authorLabel: 'You',
        timestamp: new Date().toISOString(),
        body: text,
      },
    ]);
    // Scroll to the new message immediately.
    queueMicrotask(() => this.scrollToBottom(true));

    const body: Record<string, unknown> = { text };
    if (modeOverride) body['modeOverride'] = modeOverride;

    this.api
      .post<ChatMessageResponse>(`/tickets/${this.ticketId()}/chat-message`, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          // Replace the optimistic placeholder — the real event will arrive via the next poll refresh.
          this.optimisticItems.update((items) =>
            items.filter((it) => it.id !== optimisticId),
          );

          if (res.decision === 'enqueued') {
            // Inject an "Analyzing…" placeholder that survives until the next run lands.
            const ph = this.buildAnalyzingPlaceholder(res.reanalysisJobId ?? 'pending');
            this.analyzingPlaceholderId.set(ph.id);
            this.optimisticItems.update((items) => [...items, ph]);
            this.toast.success(`Chat message sent — re-analysis queued.`);
          } else if (res.decision === 'needs_mode_pick') {
            this.toast.info('Classifier is unsure — pick a mode on the message.');
          } else {
            this.toast.success('Chat message sent.');
          }

          this.sending.set(false);
          this.replyInput()?.setDisabled(false);
          if (!opts.fromDialog) this.replyInput()?.clear();
          else this.closeNewAnalysisDialog();
        },
        error: (err) => {
          this.optimisticItems.update((items) =>
            items.filter((it) => it.id !== optimisticId),
          );
          this.toast.error(err?.error?.message ?? 'Failed to send chat message');
          this.sending.set(false);
          this.replyInput()?.setDisabled(false);
        },
      });
  }

  pickMode(item: ChatThreadItem, mode: ChatIntentLabel): void {
    if (this.modePickInFlight()) return;
    this.modePickInFlight.set(item.id);

    this.api
      .post<ChatPickModeResponse>(
        `/tickets/${this.ticketId()}/chat-message/${item.id}/pick-mode`,
        { mode },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.modePickOverrides.update((o) => ({ ...o, [item.id]: mode }));
          this.modePickInFlight.set(null);
          if (res.decision === 'enqueued') {
            if (CHAT_REANALYSIS_MODES.includes(mode as ChatReanalysisMode)) {
              const ph = this.buildAnalyzingPlaceholder(res.reanalysisJobId ?? 'pending');
              this.analyzingPlaceholderId.set(ph.id);
              this.optimisticItems.update((items) => [...items, ph]);
              queueMicrotask(() => this.scrollToBottom(true));
            }
            this.toast.success('Re-analysis queued.');
          } else {
            this.toast.info('Marked as just chat — no re-analysis.');
          }
        },
        error: (err) => {
          this.modePickInFlight.set(null);
          this.toast.error(err?.error?.message ?? 'Failed to pick mode');
        },
      });
  }

  private buildAnalyzingPlaceholder(jobId: string): ChatThreadItem {
    return {
      id: `placeholder-${jobId}-${Date.now()}`,
      role: 'assistant',
      kind: 'placeholder',
      authorLabel: 'Bronco',
      timestamp: new Date().toISOString(),
      body: '',
      placeholderText: 'Analyzing…',
    };
  }
}
