import { Component, DestroyRef, computed, inject, input, output, signal, effect } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { BroncoButtonComponent, TextareaComponent, IconComponent } from '../../shared/components/index.js';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe.js';
import { RelativeTimePipe } from '../../shared/pipes/relative-time.pipe.js';
import { TicketService, type KnowledgeDocTocEntry } from '../../core/services/ticket.service.js';

@Component({
  selector: 'app-ticket-detail-knowledge',
  standalone: true,
  imports: [FormsModule, BroncoButtonComponent, TextareaComponent, MarkdownPipe, IconComponent, RelativeTimePipe],
  template: `
    <div class="knowledge-doc" [class.with-toc]="showToc()">
      @if (editing()) {
        <div class="editor-full">
          <app-textarea
            [value]="draft()"
            [rows]="20"
            (valueChange)="draft.set($event)" />
          <div class="knowledge-actions">
            <app-bronco-button variant="primary" (click)="onSave()">Save</app-bronco-button>
            <app-bronco-button variant="secondary" (click)="onCancel()">Cancel</app-bronco-button>
          </div>
        </div>
      } @else {
        @if (showToc()) {
          <aside class="toc-sidebar">
            <div class="toc-header">
              <div class="toc-title">Sections</div>
              <button class="diff-btn" disabled title="Coming soon">Jump to iteration diffs</button>
            </div>
            @if (tocLoading()) {
              <div class="toc-empty">Loading…</div>
            } @else if (toc().length === 0) {
              <div class="toc-empty">No sections yet.</div>
            } @else {
              <ul class="toc-list">
                @for (entry of toc(); track entry.sectionKey) {
                  <li>
                    <button
                      type="button"
                      class="toc-link"
                      [class.active]="entry.sectionKey === activeSectionKey()"
                      (click)="onSelectSection(entry.sectionKey, entry.title)">
                      <span class="toc-entry-title">{{ entry.title }}</span>
                      <span class="toc-meta">
                        <span class="toc-len">{{ entry.length }} ch</span>
                        @if (entry.lastUpdatedAt) {
                          <span class="toc-updated">· {{ entry.lastUpdatedAt | relativeTime }}</span>
                        }
                      </span>
                    </button>
                    @if (entry.subsections && entry.subsections.length > 0) {
                      <ul class="toc-sublist">
                        @for (sub of entry.subsections; track sub.sectionKey) {
                          <li>
                            <button
                              type="button"
                              class="toc-link toc-sublink"
                              [class.active]="sub.sectionKey === activeSectionKey()"
                              (click)="onSelectSection(sub.sectionKey, sub.title)">
                              <span class="toc-entry-title">{{ sub.title }}</span>
                              <span class="toc-meta">
                                <span class="toc-len">{{ sub.length }} ch</span>
                                @if (sub.lastUpdatedAt) {
                                  <span class="toc-updated">· {{ sub.lastUpdatedAt | relativeTime }}</span>
                                }
                              </span>
                            </button>
                          </li>
                        }
                      </ul>
                    }
                  </li>
                }
              </ul>
            }
          </aside>
        }
        <div class="knowledge-main">
          <div class="knowledge-actions">
            <app-bronco-button variant="secondary" (click)="onStartEdit()">
              <app-icon name="edit" size="sm" /> Edit
            </app-bronco-button>
            <app-bronco-button variant="destructive" (click)="onClear()">
              <app-icon name="delete" size="sm" /> Clear
            </app-bronco-button>
          </div>
          @if (knowledgeDoc()) {
            <div class="knowledge-body" [innerHTML]="knowledgeDoc() | markdown"></div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      font-family: var(--font-primary);
      color: var(--text-primary);
    }
    .knowledge-doc {
      font-size: 14px;
      line-height: 1.6;
    }
    .knowledge-doc.with-toc {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 20px;
      align-items: start;
    }
    .toc-sidebar {
      position: sticky;
      top: 0;
      max-height: calc(100vh - 120px);
      overflow-y: auto;
      padding-right: 8px;
      border-right: 1px solid var(--border-light);
    }
    .toc-header {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 8px;
    }
    .toc-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-secondary);
      letter-spacing: 0.04em;
    }
    .diff-btn {
      font-size: 11px;
      padding: 3px 6px;
      background: var(--bg-muted);
      color: var(--text-muted);
      border: 1px dashed var(--border-light);
      border-radius: var(--radius-sm);
      cursor: not-allowed;
      text-align: left;
    }
    .toc-empty {
      font-size: 12px;
      color: var(--text-muted);
      padding: 8px 0;
    }
    .toc-list, .toc-sublist {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .toc-sublist {
      margin-left: 12px;
      border-left: 1px solid var(--border-light);
      padding-left: 8px;
      margin-top: 2px;
    }
    .toc-link {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 4px 6px;
      font-size: 13px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-primary);
      background: transparent;
      border: none;
      text-align: left;
      width: 100%;
      font-family: inherit;
    }
    .toc-link:focus-visible {
      outline: 2px solid var(--accent, #0969da);
      outline-offset: -1px;
    }
    .toc-link:hover {
      background: var(--bg-muted);
    }
    .toc-link.active {
      background: var(--bg-muted);
      font-weight: 600;
    }
    .toc-sublink {
      font-size: 12px;
    }
    .toc-entry-title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toc-meta {
      font-size: 11px;
      color: var(--text-muted);
    }
    .knowledge-doc h3 {
      margin-top: 16px;
      margin-bottom: 8px;
      font-size: 16px;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border-light);
      padding-bottom: 4px;
    }
    .knowledge-doc h4 {
      margin-top: 12px;
      margin-bottom: 6px;
      font-size: 14px;
      color: var(--text-secondary);
    }
    .knowledge-doc pre {
      background: var(--bg-code);
      color: var(--text-code);
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      overflow-x: auto;
      font-size: 12px;
    }
    .knowledge-doc code {
      background: var(--bg-muted);
      padding: 1px 4px;
      border-radius: var(--radius-sm);
      font-size: 12px;
    }
    .knowledge-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
  `],
})
export class TicketDetailKnowledgeComponent {
  private readonly ticketService = inject(TicketService);
  private readonly destroyRef = inject(DestroyRef);

  ticketId = input<string | null>(null);
  knowledgeDoc = input<string | null>(null);
  sectionMeta = input<Record<string, unknown> | null>(null);
  editing = input<boolean>(false);

  startEdit = output<void>();
  cancelEdit = output<void>();
  save = output<string>();
  clear = output<void>();

  draft = signal('');
  toc = signal<KnowledgeDocTocEntry[]>([]);
  tocLoading = signal<boolean>(false);
  activeSectionKey = signal<string | null>(null);

  // Show TOC sidebar only when the new-format sidecar is present. Legacy
  // append-only docs render as before.
  showToc = computed(() => {
    const meta = this.sectionMeta();
    return !!meta && Object.keys(meta).length > 0;
  });

  constructor() {
    // Re-fetch the TOC whenever ticketId / sectionMeta presence changes. Each
    // fetch is scoped with takeUntilDestroyed so previous in-flight requests
    // can't leak beyond component teardown, and onCleanup tracks the active
    // subscription so effect re-runs cancel their prior fetch rather than
    // stacking multiple concurrent requests.
    effect((onCleanup) => {
      const id = this.ticketId();
      const hasMeta = this.showToc();
      if (!id || !hasMeta) {
        this.toc.set([]);
        return;
      }
      this.tocLoading.set(true);
      const sub = this.ticketService
        .getKnowledgeDocToc(id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (entries) => {
            this.toc.set(entries);
            this.tocLoading.set(false);
          },
          error: () => {
            this.toc.set([]);
            this.tocLoading.set(false);
          },
        });
      onCleanup(() => sub.unsubscribe());
    });
  }

  onStartEdit(): void {
    this.draft.set(this.knowledgeDoc() ?? '');
    this.startEdit.emit();
  }

  onCancel(): void {
    this.draft.set('');
    this.cancelEdit.emit();
  }

  onSave(): void {
    this.save.emit(this.draft());
  }

  onClear(): void {
    this.clear.emit();
  }

  onSelectSection(sectionKey: string, title?: string): void {
    this.activeSectionKey.set(sectionKey);
    // Best-effort in-page scroll to a rendered heading. The markdown body
    // uses heading text slugs (e.g. "Problem Statement" → "problem-statement"),
    // not the templated section keys (`problemStatement`), so match on the
    // TOC entry's title. Falls back to the last `.`-delimited slug if no
    // title was provided (e.g. subsection keys already carry a kebab slug).
    const raw = title ?? this.toc().find((e) => e.sectionKey === sectionKey)?.title
      ?? (sectionKey.includes('.') ? (sectionKey.split('.').pop() ?? sectionKey) : sectionKey);
    const slug = this.slugifyHeading(raw);
    const headings = document.querySelectorAll<HTMLElement>('.knowledge-body h2, .knowledge-body h3');
    for (const h of Array.from(headings)) {
      const hSlug = this.slugifyHeading(h.textContent ?? '');
      if (hSlug === slug) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  }

  private slugifyHeading(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
