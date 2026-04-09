import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ReleaseNotesService, type ReleaseNote, type ReleaseNoteType } from '../../core/services/release-notes.service';
import { BackfillDialogComponent } from './backfill-dialog.component';
import { DialogComponent } from '../../shared/components/dialog.component';
import { BroncoButtonComponent, SelectComponent, PaginatorComponent, type PaginatorPageEvent } from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

const CHANGE_TYPE_META: Record<ReleaseNoteType, { label: string; color: string }> = {
  FEATURE: { label: 'Feature', color: 'var(--color-success)' },
  FIX: { label: 'Fix', color: 'var(--color-error)' },
  MAINTENANCE: { label: 'Maintenance', color: 'var(--color-warning)' },
  OTHER: { label: 'Other', color: 'var(--text-tertiary)' },
};

@Component({
  standalone: true,
  imports: [
    FormsModule,
    BroncoButtonComponent,
    SelectComponent,
    PaginatorComponent,
    DialogComponent,
    BackfillDialogComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1 class="page-title">Release Notes</h1>
        <div class="header-actions">
          <app-bronco-button variant="secondary" (click)="openBackfillDialog()" [disabled]="ingestLoading()">
            Sync History
          </app-bronco-button>
          <app-bronco-button variant="secondary" (click)="load(); loadServices(); loadTags()">
            Refresh
          </app-bronco-button>
        </div>
      </div>

      @if (loading() || ingestLoading()) {
        <div class="loading-state">Loading...</div>
      }

      <div class="filters">
        <div class="filter-field">
          <input class="text-input" type="text" [(ngModel)]="searchFilter" (keyup.enter)="resetAndLoad()" placeholder="Search commit messages...">
        </div>
        <app-select
          [value]="serviceFilter"
          [options]="serviceOptions()"
          (valueChange)="serviceFilter = $event; resetAndLoad()">
        </app-select>
        <app-select
          [value]="typeFilter"
          [options]="typeFilterOptions"
          (valueChange)="typeFilter = $event; resetAndLoad()">
        </app-select>
        <app-select
          [value]="tagFilter"
          [options]="tagOptions()"
          (valueChange)="tagFilter = $event; resetAndLoad()">
        </app-select>
        <div class="filter-field">
          <label class="filter-label">From</label>
          <input class="text-input" type="date" [(ngModel)]="fromFilter" (change)="resetAndLoad()">
        </div>
        <div class="filter-field">
          <label class="filter-label">To</label>
          <input class="text-input" type="date" [(ngModel)]="toFilter" (change)="resetAndLoad()">
        </div>
      </div>

      <div class="notes-list">
        @if (notes().length === 0 && !loading()) {
          <p class="empty">No release notes found. Deploy to production or use "Sync History" to backfill.</p>
        }
        @for (group of groupedNotes(); track group.tag) {
          <div class="release-group">
            <div class="release-header">
              <span class="release-tag">{{ group.tag }}</span>
              <span class="release-count">{{ group.notes.length }} commit{{ group.notes.length === 1 ? '' : 's' }}</span>
            </div>
            @for (note of group.notes; track note.id) {
              <div class="note-card" [class.hidden-note]="!note.isVisible" [style.border-left-color]="typeColor(note.changeType)">
                <div class="note-header">
                  <div class="note-meta">
                    <span class="type-badge" [style.background]="typeColor(note.changeType)">
                      {{ typeLabel(note.changeType) }}
                    </span>
                    @for (svc of note.services; track svc) {
                      <span class="service-chip">{{ svc }}</span>
                    }
                    <span class="commit-date">{{ formatDate(note.commitDate) }}</span>
                    <code class="commit-sha">{{ note.commitSha.slice(0, 7) }}</code>
                  </div>
                  <div class="note-actions">
                    <app-bronco-button variant="icon" size="sm"
                      [title]="note.isVisible ? 'Mark as hidden' : 'Mark as visible'"
                      [attr.aria-label]="note.isVisible ? 'Mark as hidden' : 'Mark as visible'"
                      (click)="toggleVisibility(note)">
                      {{ note.isVisible ? '◉' : '○' }}
                    </app-bronco-button>
                  </div>
                </div>

                <hr class="divider">

                <div class="note-summary">
                  @if (note.summary) {
                    <p class="summary-text">{{ note.summary }}</p>
                  } @else {
                    <p class="summary-pending">Summary pending — AI provider not configured or unavailable.</p>
                  }
                </div>

                @if (expandedNotes().has(note.id)) {
                  <div class="raw-message">
                    <pre>{{ note.rawMessage }}</pre>
                  </div>
                }

                <app-bronco-button variant="ghost" size="sm" class="toggle-raw-btn" (click)="toggleRaw(note.id)">
                  {{ expandedNotes().has(note.id) ? '▲ Hide' : '▼ Show' }} raw commit message
                </app-bronco-button>
              </div>
            }
          </div>
        }
      </div>

      <app-paginator
        [length]="total()"
        [pageSize]="pageSize"
        [pageIndex]="pageIndex"
        [pageSizeOptions]="[25, 50, 100]"
        (page)="onPage($event)" />
    </div>

    @if (showBackfillDialog()) {
      <app-dialog [open]="true" title="Sync History" maxWidth="480px" (openChange)="showBackfillDialog.set(false)">
        <app-backfill-dialog-content
          (submitted)="onBackfillSubmitted($event)"
          (cancelled)="showBackfillDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .header-actions { display: flex; gap: 8px; }

    .loading-state {
      font-family: var(--font-primary); font-size: 13px; color: var(--accent);
      padding: 8px 0; margin-bottom: 8px;
    }

    .filters {
      display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; align-items: flex-end;
    }
    .filters app-select { min-width: 160px; }
    .filter-field { display: flex; flex-direction: column; gap: 4px; }
    .filter-label { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); }
    .text-input {
      background: var(--bg-card); border: 1px solid var(--border-medium);
      border-radius: var(--radius-md); padding: 8px 12px; font-family: var(--font-primary);
      font-size: 14px; color: var(--text-primary); outline: none; min-width: 160px;
    }
    .text-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--focus-ring); }

    .notes-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }

    .note-card {
      background: var(--bg-card); border-radius: var(--radius-lg); padding: 16px;
      box-shadow: var(--shadow-card); border-left: 4px solid var(--text-tertiary);
      transition: opacity 0.2s;
    }
    .note-card.hidden-note { opacity: 0.5; }

    .note-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 8px; flex-wrap: wrap; gap: 8px;
    }
    .note-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .type-badge {
      display: inline-flex; align-items: center; gap: 4px;
      font-family: var(--font-primary); font-size: 11px; font-weight: 600;
      color: var(--text-on-accent); padding: 3px 8px; border-radius: var(--radius-pill);
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .service-chip {
      font-family: var(--font-primary); font-size: 11px;
      background: var(--color-info-subtle); color: var(--accent);
      padding: 2px 8px; border-radius: var(--radius-pill); font-weight: 500;
    }
    .commit-date { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); }
    .commit-sha {
      font-size: 11px; background: var(--bg-muted); padding: 2px 6px;
      border-radius: var(--radius-sm); color: var(--text-tertiary); font-family: monospace;
    }
    .note-actions { flex-shrink: 0; }

    .divider { border: none; border-top: 1px solid var(--border-light); margin: 12px 0; }

    .note-summary { margin: 10px 0 6px; }
    .summary-text {
      margin: 0; line-height: 1.6; font-family: var(--font-primary);
      font-size: 14px; color: var(--text-secondary);
    }
    .summary-pending {
      margin: 0; font-family: var(--font-primary); font-size: 13px;
      color: var(--text-tertiary); font-style: italic;
    }
    .raw-message {
      margin-top: 8px; background: var(--bg-muted); border-radius: var(--radius-sm); padding: 10px 12px;
    }
    .raw-message pre {
      margin: 0; white-space: pre-wrap; font-size: 12px;
      color: var(--text-tertiary); line-height: 1.5;
    }
    .toggle-raw-btn { margin-top: 4px; }

    .empty {
      text-align: center; color: var(--text-tertiary); padding: 48px 0;
      font-family: var(--font-primary);
    }

    .release-group { display: flex; flex-direction: column; gap: 8px; }
    .release-header {
      display: flex; align-items: center; gap: 8px; padding: 6px 4px;
      border-bottom: 2px solid var(--border-light); margin-bottom: 4px;
    }
    .release-tag {
      font-family: monospace; font-size: 15px; font-weight: 700;
      color: var(--accent);
    }
    .release-count { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); margin-left: 4px; }
  `],
})
export class ReleaseNotesComponent implements OnInit {
  private releaseNotesService = inject(ReleaseNotesService);
  private toast = inject(ToastService);
  showBackfillDialog = signal(false);

  notes = signal<ReleaseNote[]>([]);
  availableServices = signal<string[]>([]);
  availableTags = signal<string[]>([]);
  total = signal(0);
  loading = signal(false);
  ingestLoading = signal(false);
  expandedNotes = signal<Set<string>>(new Set());

  groupedNotes = computed(() => {
    const noteList = this.notes();
    const groups = new Map<string, ReleaseNote[]>();
    for (const note of noteList) {
      const key = note.releaseTag ?? 'Untagged';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(note);
    }
    const result: Array<{ tag: string; notes: ReleaseNote[] }> = [];
    for (const [tag, tagNotes] of groups) {
      if (tag !== 'Untagged') result.push({ tag, notes: tagNotes });
    }
    // Sort tagged groups by semver (desc)
    result.sort((a, b) => b.tag.localeCompare(a.tag, undefined, { numeric: true, sensitivity: 'base' }));
    if (groups.has('Untagged')) result.push({ tag: 'Untagged', notes: groups.get('Untagged')! });
    return result;
  });

  serviceOptions = computed(() => [
    { value: '', label: 'All Services' },
    ...this.availableServices().map(s => ({ value: s, label: s })),
  ]);

  tagOptions = computed(() => [
    { value: '', label: 'All Releases' },
    ...this.availableTags().map(t => ({ value: t, label: t })),
  ]);

  typeFilterOptions = [
    { value: '', label: 'All Types' },
    { value: 'FEATURE', label: 'Feature' },
    { value: 'FIX', label: 'Fix' },
    { value: 'MAINTENANCE', label: 'Maintenance' },
    { value: 'OTHER', label: 'Other' },
  ];

  searchFilter = '';
  serviceFilter = '';
  typeFilter = '';
  tagFilter = '';
  fromFilter = '';
  toFilter = '';

  pageSize = 50;
  pageIndex = 0;

  ngOnInit(): void {
    this.load();
    this.loadServices();
    this.loadTags();
  }

  load(): void {
    this.loading.set(true);
    this.releaseNotesService.list({
      search: this.searchFilter || undefined,
      service: this.serviceFilter || undefined,
      changeType: this.typeFilter || undefined,
      tag: this.tagFilter || undefined,
      from: this.fromFilter || undefined,
      to: this.toFilter || undefined,
      limit: this.pageSize,
      offset: this.pageIndex * this.pageSize,
    }).subscribe({
      next: (r) => {
        this.notes.set(r.items);
        this.total.set(r.total);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.toast.error('Failed to load release notes');
      },
    });
  }

  loadServices(): void {
    this.releaseNotesService.getServices().subscribe({
      next: (s) => this.availableServices.set(s),
    });
  }

  loadTags(): void {
    this.releaseNotesService.getTags().subscribe({
      next: (t) => {
        const sorted = [...t].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
        this.availableTags.set(sorted);
      },
    });
  }

  resetAndLoad(): void {
    this.pageIndex = 0;
    this.load();
  }

  onPage(event: PaginatorPageEvent): void {
    this.pageSize = event.pageSize;
    this.pageIndex = event.pageIndex;
    this.load();
  }

  toggleRaw(id: string): void {
    const current = new Set(this.expandedNotes());
    if (current.has(id)) current.delete(id);
    else current.add(id);
    this.expandedNotes.set(current);
  }

  toggleVisibility(note: ReleaseNote): void {
    this.releaseNotesService.update(note.id, !note.isVisible).subscribe({
      next: (updated) => {
        this.notes.update((list) => list.map((n) => (n.id === updated.id ? updated : n)));
      },
      error: () => {
        this.toast.error('Failed to update visibility');
      },
    });
  }

  openBackfillDialog(): void {
    this.showBackfillDialog.set(true);
  }

  onBackfillSubmitted(result: { fromSha: string; toSha?: string }): void {
    this.showBackfillDialog.set(false);
    this.ingestLoading.set(true);
    this.releaseNotesService.backfill(result.fromSha, result.toSha).subscribe({
      next: (r) => {
        this.ingestLoading.set(false);
        this.toast.success(`Sync complete — ${r.ingested} ingested, ${r.skipped} skipped`);
        this.load();
        this.loadServices();
        this.loadTags();
      },
      error: (err) => {
        this.ingestLoading.set(false);
        this.toast.error(err.error?.error ?? 'Backfill failed');
      },
    });
  }

  typeLabel(t: string): string { return CHANGE_TYPE_META[t as ReleaseNoteType]?.label ?? t; }
  typeColor(t: string): string { return CHANGE_TYPE_META[t as ReleaseNoteType]?.color ?? 'var(--text-tertiary)'; }

  formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
