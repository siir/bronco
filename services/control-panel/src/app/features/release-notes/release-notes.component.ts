import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatChipsModule } from '@angular/material/chips';
import { MatPaginatorModule, type PageEvent } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { ReleaseNotesService, type ReleaseNote, type ReleaseNoteType } from '../../core/services/release-notes.service';
import { BackfillDialogComponent } from './backfill-dialog.component';

const CHANGE_TYPE_META: Record<ReleaseNoteType, { label: string; color: string; icon: string }> = {
  FEATURE: { label: 'Feature', color: '#4caf50', icon: 'new_releases' },
  FIX: { label: 'Fix', color: '#f44336', icon: 'bug_report' },
  MAINTENANCE: { label: 'Maintenance', color: '#ff9800', icon: 'build' },
  OTHER: { label: 'Other', color: '#9e9e9e', icon: 'more_horiz' },
};

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatChipsModule,
    MatPaginatorModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatDialogModule,
    MatDividerModule,
  ],
  template: `
    <div class="page-header">
      <h1>Release Notes</h1>
      <div class="header-actions">
        <button mat-stroked-button (click)="openBackfillDialog()" [disabled]="ingestLoading()">
          <mat-icon>history</mat-icon> Sync History
        </button>
        <button mat-raised-button (click)="load(); loadServices(); loadTags()">
          <mat-icon>refresh</mat-icon> Refresh
        </button>
      </div>
    </div>

    @if (loading() || ingestLoading()) {
      <mat-progress-bar mode="indeterminate"></mat-progress-bar>
    }

    <div class="filters">
      <mat-form-field>
        <mat-label>Search</mat-label>
        <input matInput [(ngModel)]="searchFilter" (keyup.enter)="resetAndLoad()" placeholder="Commit message or summary…">
        <button mat-icon-button matSuffix (click)="resetAndLoad()" [disabled]="!searchFilter">
          <mat-icon>search</mat-icon>
        </button>
      </mat-form-field>

      <mat-form-field>
        <mat-label>Service</mat-label>
        <mat-select [(ngModel)]="serviceFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All Services</mat-option>
          @for (s of availableServices(); track s) {
            <mat-option [value]="s">{{ s }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field>
        <mat-label>Change Type</mat-label>
        <mat-select [(ngModel)]="typeFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All Types</mat-option>
          <mat-option value="FEATURE">Feature</mat-option>
          <mat-option value="FIX">Fix</mat-option>
          <mat-option value="MAINTENANCE">Maintenance</mat-option>
          <mat-option value="OTHER">Other</mat-option>
        </mat-select>
      </mat-form-field>

      <mat-form-field>
        <mat-label>Release</mat-label>
        <mat-select [(ngModel)]="tagFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All Releases</mat-option>
          @for (t of availableTags(); track t) {
            <mat-option [value]="t">{{ t }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field>
        <mat-label>From</mat-label>
        <input matInput type="date" [(ngModel)]="fromFilter" (change)="resetAndLoad()">
      </mat-form-field>

      <mat-form-field>
        <mat-label>To</mat-label>
        <input matInput type="date" [(ngModel)]="toFilter" (change)="resetAndLoad()">
      </mat-form-field>
    </div>

    <div class="notes-list">
      @if (notes().length === 0 && !loading()) {
        <p class="empty">No release notes found. Deploy to production or use "Sync History" to backfill.</p>
      }
      @for (group of groupedNotes(); track group.tag) {
        <div class="release-group">
          <div class="release-header">
            <mat-icon class="release-icon">local_offer</mat-icon>
            <span class="release-tag">{{ group.tag }}</span>
            <span class="release-count">{{ group.notes.length }} commit{{ group.notes.length === 1 ? '' : 's' }}</span>
          </div>
          @for (note of group.notes; track note.id) {
            <mat-card class="note-card" [class.hidden-note]="!note.isVisible" [style.border-left-color]="typeColor(note.changeType)">
              <mat-card-content>
                <div class="note-header">
                  <div class="note-meta">
                    <span class="type-badge" [style.background]="typeColor(note.changeType)">
                      <mat-icon>{{ typeIcon(note.changeType) }}</mat-icon>
                      {{ typeLabel(note.changeType) }}
                    </span>
                    @for (svc of note.services; track svc) {
                      <span class="service-chip">{{ svc }}</span>
                    }
                    <span class="commit-date">{{ formatDate(note.commitDate) }}</span>
                    <code class="commit-sha">{{ note.commitSha.slice(0, 7) }}</code>
                  </div>
                  <div class="note-actions">
                    <button mat-icon-button
                      [matTooltip]="note.isVisible ? 'Mark as hidden' : 'Mark as visible'"
                      (click)="toggleVisibility(note)">
                      <mat-icon>{{ note.isVisible ? 'visibility' : 'visibility_off' }}</mat-icon>
                    </button>
                  </div>
                </div>

                <mat-divider></mat-divider>

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

                <button mat-button class="toggle-raw-btn" (click)="toggleRaw(note.id)">
                  <mat-icon>{{ expandedNotes().has(note.id) ? 'expand_less' : 'expand_more' }}</mat-icon>
                  {{ expandedNotes().has(note.id) ? 'Hide' : 'Show' }} raw commit message
                </button>
              </mat-card-content>
            </mat-card>
          }
        </div>
      }
    </div>

    <mat-paginator
      [length]="total()"
      [pageSize]="pageSize"
      [pageIndex]="pageIndex"
      [pageSizeOptions]="[25, 50, 100]"
      (page)="onPage($event)"
      showFirstLastButtons>
    </mat-paginator>
  `,
  styles: [`
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
      align-items: flex-start;
    }
    .filters mat-form-field {
      min-width: 160px;
    }
    .notes-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 16px;
    }
    .note-card {
      border-left: 4px solid #9e9e9e;
      transition: opacity 0.2s;
    }
    .note-card.hidden-note {
      opacity: 0.5;
    }
    .note-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .note-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .type-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      color: white;
      padding: 3px 8px;
      border-radius: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .type-badge mat-icon {
      font-size: 13px;
      width: 13px;
      height: 13px;
    }
    .service-chip {
      font-size: 11px;
      background: #e3f2fd;
      color: #1565c0;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
    }
    .commit-date {
      font-size: 12px;
      color: #999;
    }
    .commit-sha {
      font-size: 11px;
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 4px;
      color: #666;
      font-family: monospace;
    }
    .note-actions {
      flex-shrink: 0;
    }
    .note-summary {
      margin: 10px 0 6px;
    }
    .summary-text {
      margin: 0;
      line-height: 1.6;
      font-size: 14px;
      color: #333;
    }
    .summary-pending {
      margin: 0;
      font-size: 13px;
      color: #bbb;
      font-style: italic;
    }
    .raw-message {
      margin-top: 8px;
      background: #f5f5f5;
      border-radius: 4px;
      padding: 10px 12px;
    }
    .raw-message pre {
      margin: 0;
      white-space: pre-wrap;
      font-size: 12px;
      color: #555;
      line-height: 1.5;
    }
    .toggle-raw-btn {
      margin-top: 4px;
      font-size: 12px;
      color: #999;
    }
    .empty {
      text-align: center;
      color: #999;
      padding: 48px 0;
    }
    .release-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .release-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 4px;
      border-bottom: 2px solid #e0e0e0;
      margin-bottom: 4px;
    }
    .release-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      color: #5c6bc0;
    }
    .release-tag {
      font-size: 15px;
      font-weight: 700;
      color: #3949ab;
      font-family: monospace;
    }
    .release-count {
      font-size: 12px;
      color: #999;
      margin-left: 4px;
    }
  `],
})
export class ReleaseNotesComponent implements OnInit {
  private releaseNotesService = inject(ReleaseNotesService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

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
        this.snackBar.open('Failed to load release notes', 'OK', { duration: 5000 });
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

  onPage(event: PageEvent): void {
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
        this.snackBar.open('Failed to update visibility', 'OK', { duration: 5000 });
      },
    });
  }

  openBackfillDialog(): void {
    const ref = this.dialog.open(BackfillDialogComponent, { width: '480px' });
    ref.afterClosed().subscribe((result: { fromSha: string; toSha?: string } | undefined) => {
      if (!result) return;
      this.ingestLoading.set(true);
      this.releaseNotesService.backfill(result.fromSha, result.toSha).subscribe({
        next: (r) => {
          this.ingestLoading.set(false);
          this.snackBar.open(`Sync complete — ${r.ingested} ingested, ${r.skipped} skipped`, 'OK', { duration: 5000 });
          this.load();
          this.loadServices();
          this.loadTags();
        },
        error: (err) => {
          this.ingestLoading.set(false);
          this.snackBar.open(err.error?.error ?? 'Backfill failed', 'OK', { duration: 8000 });
        },
      });
    });
  }

  typeLabel(t: string): string { return CHANGE_TYPE_META[t as ReleaseNoteType]?.label ?? t; }
  typeColor(t: string): string { return CHANGE_TYPE_META[t as ReleaseNoteType]?.color ?? '#9e9e9e'; }
  typeIcon(t: string): string { return CHANGE_TYPE_META[t as ReleaseNoteType]?.icon ?? 'circle'; }

  formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
