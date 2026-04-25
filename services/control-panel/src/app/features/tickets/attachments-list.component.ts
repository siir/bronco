import { Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { TicketService, type ArtifactKind, type TicketArtifact } from '../../core/services/ticket.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { BroncoButtonComponent, IconComponent } from '../../shared/components/index.js';
import type { IconName } from '../../shared/components/icon-registry.js';
import { RelativeTimePipe } from '../../shared/pipes/relative-time.pipe.js';

/**
 * Finder-style attachments panel for a ticket.
 *
 * Lists every Artifact with `ticketId = X` enriched with the Phase 1 fields
 * (kind, displayName, source, addedBy, etc). Supports operator uploads via
 * the Phase 1 `POST /api/artifacts/upload` endpoint.
 */
@Component({
  selector: 'app-attachments-list',
  standalone: true,
  imports: [CommonModule, BroncoButtonComponent, IconComponent, RelativeTimePipe],
  template: `
    <div class="attachments-panel">
      <div class="attachments-toolbar">
        <div class="attachments-summary">
          @if (loaded()) {
            <span class="att-count">{{ artifacts().length }} item{{ artifacts().length === 1 ? '' : 's' }}</span>
          } @else {
            <span class="att-count att-count-muted">Loading…</span>
          }
        </div>
        <div class="attachments-actions">
          <app-bronco-button variant="secondary" size="sm" (click)="refresh()" [disabled]="loading()">
            <app-icon name="refresh" size="sm" /> Refresh
          </app-bronco-button>
          <label class="upload-btn" [class.upload-disabled]="uploading()">
            <app-icon name="cloud-upload" size="sm" />
            <span>{{ uploading() ? 'Uploading…' : 'Upload' }}</span>
            <input
              type="file"
              class="upload-input"
              [disabled]="uploading()"
              (change)="onFilePicked($event)" />
          </label>
        </div>
      </div>

      @if (loaded() && artifacts().length === 0) {
        <div class="empty-state-card">
          <app-icon name="paperclip" size="lg" />
          <p class="empty-title">No attachments yet</p>
          <p class="empty-sub">Drop a file or use the Upload button to attach one to this ticket.</p>
          <label class="upload-btn upload-btn-primary" [class.upload-disabled]="uploading()">
            <app-icon name="cloud-upload" size="sm" />
            <span>{{ uploading() ? 'Uploading…' : 'Choose file' }}</span>
            <input
              type="file"
              class="upload-input"
              [disabled]="uploading()"
              (change)="onFilePicked($event)" />
          </label>
        </div>
      } @else if (loaded()) {
        <div class="att-grid" role="list">
          @for (a of artifacts(); track a.id) {
            <div class="att-row" role="listitem">
              <div class="att-icon-wrap" [attr.data-kind]="a.kind ?? 'OTHER'">
                <app-icon [name]="iconFor(a)" size="lg" />
              </div>
              <div class="att-main">
                <div class="att-line att-line-title">
                  <span class="att-name" [title]="displayNameOf(a)">{{ displayNameOf(a) }}</span>
                  @if (a.kind) {
                    <span class="att-kind-pill" [attr.data-kind]="a.kind">{{ kindLabel(a.kind) }}</span>
                  }
                </div>
                @if (a.source) {
                  <div class="att-source">{{ a.source }}</div>
                }
                <div class="att-meta">
                  <span class="att-meta-item">
                    <app-icon name="user" size="xs" />
                    <span>{{ addedByLabel(a) }}</span>
                  </span>
                  <span class="att-meta-dot">&middot;</span>
                  <span class="att-meta-item">{{ formatBytes(a.sizeBytes) }}</span>
                  <span class="att-meta-dot">&middot;</span>
                  <span class="att-meta-item" [title]="a.createdAt">{{ a.createdAt | relativeTime }}</span>
                  @if (a.mimeType) {
                    <span class="att-meta-dot">&middot;</span>
                    <code class="att-mime">{{ a.mimeType }}</code>
                  }
                </div>
                @if (a.description) {
                  <div class="att-desc">{{ a.description }}</div>
                }
              </div>
              <div class="att-actions">
                <app-bronco-button variant="ghost" size="sm" (click)="view(a)" [disabled]="!isViewable(a)">
                  <app-icon name="visible" size="sm" /> View
                </app-bronco-button>
                <app-bronco-button variant="secondary" size="sm" (click)="download(a)">
                  <app-icon name="download" size="sm" /> Download
                </app-bronco-button>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .attachments-panel { display: flex; flex-direction: column; gap: 12px; }

    .attachments-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .attachments-summary { display: flex; align-items: center; gap: 8px; }
    .att-count { font-size: 12px; color: var(--text-secondary); }
    .att-count-muted { color: var(--text-tertiary); }
    .attachments-actions { display: flex; align-items: center; gap: 8px; }

    .upload-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 12px;
      color: var(--text-primary);
      background: var(--bg-card);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .upload-btn:hover:not(.upload-disabled) {
      background: var(--bg-muted);
      border-color: var(--border-strong, var(--border-light));
    }
    .upload-btn-primary {
      background: var(--accent);
      color: var(--accent-contrast, white);
      border-color: var(--accent);
    }
    .upload-btn-primary:hover:not(.upload-disabled) {
      filter: brightness(1.05);
      background: var(--accent);
    }
    .upload-disabled { opacity: 0.6; cursor: not-allowed; }
    .upload-input {
      position: absolute;
      width: 1px; height: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .empty-state-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 32px 16px;
      background: var(--bg-card);
      border: 1px dashed var(--border-light);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
    }
    .empty-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .empty-sub { font-size: 12px; color: var(--text-tertiary); margin: 0 0 6px 0; text-align: center; }

    .att-grid {
      display: flex;
      flex-direction: column;
      gap: 1px;
      background: var(--bg-card);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-md);
      overflow: hidden;
    }

    .att-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border-light);
      transition: background 120ms ease;
    }
    .att-row:last-child { border-bottom: none; }
    .att-row:hover { background: var(--bg-muted); }

    .att-icon-wrap {
      width: 36px; height: 36px;
      display: flex; align-items: center; justify-content: center;
      border-radius: var(--radius-sm);
      background: var(--bg-muted);
      color: var(--text-secondary);
      flex-shrink: 0;
    }
    .att-icon-wrap[data-kind="PROBE_RESULT"]      { background: var(--color-info-subtle, var(--bg-muted));    color: var(--color-info, var(--text-secondary)); }
    .att-icon-wrap[data-kind="MCP_TOOL_RESULT"]   { background: var(--color-warning-subtle, var(--bg-muted)); color: var(--color-warning, var(--text-secondary)); }
    .att-icon-wrap[data-kind="EMAIL_ATTACHMENT"]  { background: var(--color-success-subtle, var(--bg-muted)); color: var(--color-success, var(--text-secondary)); }
    .att-icon-wrap[data-kind="OPERATOR_UPLOAD"]   { background: var(--accent-subtle, var(--bg-muted));        color: var(--accent, var(--text-secondary)); }

    .att-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .att-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .att-line-title { flex-wrap: wrap; }
    .att-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .att-kind-pill {
      font-size: 10px;
      letter-spacing: 0.02em;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 999px;
      background: var(--bg-muted);
      color: var(--text-secondary);
      flex-shrink: 0;
    }
    .att-kind-pill[data-kind="PROBE_RESULT"]     { background: var(--color-info-subtle, var(--bg-muted));    color: var(--color-info, var(--text-secondary)); }
    .att-kind-pill[data-kind="MCP_TOOL_RESULT"]  { background: var(--color-warning-subtle, var(--bg-muted)); color: var(--color-warning, var(--text-secondary)); }
    .att-kind-pill[data-kind="EMAIL_ATTACHMENT"] { background: var(--color-success-subtle, var(--bg-muted)); color: var(--color-success, var(--text-secondary)); }
    .att-kind-pill[data-kind="OPERATOR_UPLOAD"]  { background: var(--accent-subtle, var(--bg-muted));        color: var(--accent, var(--text-secondary)); }

    .att-source { font-size: 11px; color: var(--text-tertiary); }
    .att-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-tertiary);
    }
    .att-meta-item { display: inline-flex; align-items: center; gap: 4px; }
    .att-meta-dot { color: var(--text-tertiary); opacity: 0.6; }
    .att-mime {
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 4px;
      background: var(--bg-muted);
      color: var(--text-secondary);
    }
    .att-desc {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }

    .att-actions { display: flex; gap: 6px; flex-shrink: 0; }
  `],
})
export class AttachmentsListComponent implements OnInit {
  ticketId = input.required<string>();

  private ticketService = inject(TicketService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  artifacts = signal<TicketArtifact[]>([]);
  loaded = signal(false);
  loading = signal(false);
  uploading = signal(false);

  // Already sorted desc by API; keep client-side sort as a safety net.
  sortedArtifacts = computed(() =>
    [...this.artifacts()].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)),
  );

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.ticketService
      .getArtifacts(this.ticketId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.artifacts.set(list);
          this.loaded.set(true);
          this.loading.set(false);
        },
        error: () => {
          this.toast.error('Failed to load attachments');
          this.loading.set(false);
        },
      });
  }

  async onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;
    this.uploading.set(true);
    try {
      await this.ticketService.uploadArtifact(this.ticketId(), file);
      this.toast.success('Uploaded');
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      this.toast.error(msg);
    } finally {
      this.uploading.set(false);
      // Reset the input so the same file can be picked again if needed.
      input.value = '';
    }
  }

  download(a: TicketArtifact): void {
    void this.ticketService.downloadArtifact(a.id);
  }

  /**
   * "View" for now opens the same download URL in a new tab — for text/json/image/pdf
   * the browser will render inline; for other types it'll prompt download. Phase 1
   * does not have a separate inline-content endpoint, so we re-use /download.
   */
  view(a: TicketArtifact): void {
    if (!this.isViewable(a)) {
      this.download(a);
      return;
    }
    const url = `/api/artifacts/${a.id}/download`;
    window.open(url, '_blank', 'noopener');
  }

  isViewable(a: TicketArtifact): boolean {
    const m = (a.mimeType ?? '').toLowerCase();
    if (!m) return false;
    return (
      m.startsWith('text/') ||
      m.startsWith('image/') ||
      m === 'application/json' ||
      m === 'application/pdf'
    );
  }

  displayNameOf(a: TicketArtifact): string {
    if (a.displayName) return a.displayName;
    if (a.filename) return a.filename;
    const kind = a.kind ?? 'artifact';
    return `${kind}: ${a.id.slice(0, 8)}`;
  }

  addedByLabel(a: TicketArtifact): string {
    if (a.addedByPerson?.name) return a.addedByPerson.name;
    if (a.addedBySystem) return a.addedBySystem;
    return '—';
  }

  kindLabel(kind: ArtifactKind): string {
    switch (kind) {
      case 'PROBE_RESULT': return 'Probe';
      case 'MCP_TOOL_RESULT': return 'Tool';
      case 'EMAIL_ATTACHMENT': return 'Email';
      case 'OPERATOR_UPLOAD': return 'Upload';
      default: return kind;
    }
  }

  /**
   * Pick an icon by kind first, then refine for EMAIL_ATTACHMENT / OPERATOR_UPLOAD
   * by mimeType so users can scan attached docs at a glance.
   */
  iconFor(a: TicketArtifact): IconName {
    const mimeIcon = this.iconForMime(a.mimeType);
    switch (a.kind) {
      case 'PROBE_RESULT':
        return 'chart-line';
      case 'MCP_TOOL_RESULT':
        return 'puzzle-piece';
      case 'EMAIL_ATTACHMENT':
        return mimeIcon ?? 'paperclip';
      case 'OPERATOR_UPLOAD':
        return mimeIcon ?? 'cloud-upload';
      default:
        return mimeIcon ?? 'file';
    }
  }

  private iconForMime(mime: string | null | undefined): IconName | null {
    if (!mime) return null;
    const m = mime.toLowerCase();
    if (m.startsWith('image/')) return 'file-image';
    if (m === 'application/pdf') return 'file-pdf';
    if (m === 'application/json' || m.startsWith('text/')) return 'file';
    return null;
  }

  formatBytes(bytes: number): string {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}
