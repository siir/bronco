import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, JsonPipe, NgClass } from '@angular/common';
import {
  ToolRequestService,
  ToolRequestStatus,
  type ToolRequestListItem,
  type ToolRequestDetail,
  type UpdateToolRequestBody,
} from '../../core/services/tool-request.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import {
  BroncoButtonComponent,
  CardComponent,
  FormFieldComponent,
  SelectComponent,
  TextInputComponent,
  ToolbarComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
} from '../../shared/components/index.js';

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: ToolRequestStatus.PROPOSED, label: 'Proposed' },
  { value: ToolRequestStatus.APPROVED, label: 'Approved' },
  { value: ToolRequestStatus.REJECTED, label: 'Rejected' },
  { value: ToolRequestStatus.IMPLEMENTED, label: 'Implemented' },
  { value: ToolRequestStatus.DUPLICATE, label: 'Duplicate' },
];

@Component({
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    JsonPipe,
    NgClass,
    BroncoButtonComponent,
    CardComponent,
    FormFieldComponent,
    SelectComponent,
    TextInputComponent,
    ToolbarComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
  ],
  template: `
    <div class="page-header">
      <h1>Tool Requests</h1>
      <div class="header-actions">
        <app-bronco-button variant="secondary" size="sm" (click)="refresh()" [disabled]="loading()">
          ↻ Refresh
        </app-bronco-button>
      </div>
    </div>

    <p class="page-hint">
      Agent-flagged capability gaps. Each row represents a missing tool the analyzer wished it had, deduplicated by
      <code>(client, requested_name)</code> with rationale history.
    </p>

    <app-toolbar>
      <app-select
        [value]="statusFilter()"
        [options]="statusOptions"
        (valueChange)="onStatusFilter($event)" />
      <app-text-input
        type="text"
        [value]="searchInput()"
        placeholder="Search name or title..."
        (valueChange)="onSearchChange($event)" />
    </app-toolbar>

    @if (loading() && items().length === 0) {
      <div class="loading-state">Loading tool requests...</div>
    }

    @if (!loading() && items().length === 0) {
      <app-card>
        <div class="empty-state">
          <p>No tool requests{{ statusFilter() ? ' with status ' + statusFilter() : '' }}.</p>
          <p class="empty-hint">When the analyzer identifies a missing capability it will post a <code>request_tool</code> call and surface it here.</p>
        </div>
      </app-card>
    }

    @if (items().length > 0) {
      <app-data-table [data]="items()" [trackBy]="trackById" (rowClick)="openDetail($event)">
        <app-data-column key="status" header="Status" width="120px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="status-pill" [ngClass]="statusClass(row.status)">{{ row.status }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="displayTitle" header="Title" [sortable]="false">
          <ng-template #cell let-row>
            <div class="title-cell">
              <span class="title">{{ row.displayTitle }}</span>
              <span class="requested-name">{{ row.requestedName }}</span>
            </div>
          </ng-template>
        </app-data-column>

        <app-data-column key="client" header="Client" width="180px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="client-name">{{ row.client.name }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="requestCount" header="Count" width="80px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="count-pill">{{ row.requestCount }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="updatedAt" header="Last Updated" width="160px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="time">{{ row.updatedAt | date:'short' }}</span>
          </ng-template>
        </app-data-column>
      </app-data-table>

      @if (total() > items().length) {
        <div class="load-more">
          <app-bronco-button variant="secondary" (click)="loadMore()" [disabled]="loading()">
            Load More ({{ items().length }} of {{ total() }})
          </app-bronco-button>
        </div>
      }
    }

    @if (detail(); as d) {
      <app-dialog [open]="true" [title]="d.displayTitle" maxWidth="720px" (openChange)="closeDetail()">
        <div class="detail">
          <div class="detail-header">
            <span class="status-pill" [ngClass]="statusClass(d.status)">{{ d.status }}</span>
            <span class="requested-name-big">{{ d.requestedName }}</span>
            <span class="count-pill">requests: {{ d.requestCount }}</span>
          </div>

          <section>
            <h3>Description</h3>
            <p class="body-text">{{ d.description }}</p>
          </section>

          @if (d.exampleUsage) {
            <section>
              <h3>Example Usage</h3>
              <pre class="code-block">{{ d.exampleUsage }}</pre>
            </section>
          }

          @if (d.suggestedInputs) {
            <section>
              <h3>Suggested Inputs</h3>
              <pre class="code-block">{{ d.suggestedInputs | json }}</pre>
            </section>
          }

          <section>
            <h3>Rationale History ({{ d.rationales.length }})</h3>
            @for (r of d.rationales; track r.id) {
              <div class="rationale">
                <div class="rationale-meta">
                  <span class="source-tag">{{ r.source }}</span>
                  @if (r.ticket) {
                    <span class="ticket-ref">#{{ r.ticket.ticketNumber }} · {{ r.ticket.subject }}</span>
                  }
                  <span class="time">{{ r.createdAt | date:'short' }}</span>
                </div>
                <div class="rationale-text">{{ r.rationale }}</div>
              </div>
            }
          </section>

          @if (d.linkedTickets.length > 0) {
            <section>
              <h3>Linked Tickets</h3>
              <ul class="ticket-list">
                @for (t of d.linkedTickets; track t.id) {
                  <li>#{{ t.ticketNumber }} — {{ t.subject }} <span class="muted">({{ t.status }})</span></li>
                }
              </ul>
            </section>
          }

          @if (d.duplicateOf) {
            <section>
              <h3>Duplicate Of</h3>
              <p>{{ d.duplicateOf.displayTitle }} ({{ d.duplicateOf.requestedName }}) — {{ d.duplicateOf.status }}</p>
            </section>
          }

          @if (d.duplicates.length > 0) {
            <section>
              <h3>Duplicates Pointing Here</h3>
              <ul class="dup-list">
                @for (dup of d.duplicates; track dup.id) {
                  <li>{{ dup.displayTitle }} ({{ dup.requestedName }}) — {{ dup.status }} · {{ dup.requestCount }}</li>
                }
              </ul>
            </section>
          }

          <section class="transition-section">
            <h3>Change Status</h3>

            @if (d.status === 'PROPOSED') {
              <div class="action-row">
                <app-bronco-button variant="primary" (click)="approve(d)" [disabled]="saving()">Approve</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="showRejectForm.set(true)" [disabled]="saving()">Reject</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="showDuplicateForm.set(true)" [disabled]="saving()">Mark Duplicate</app-bronco-button>
              </div>
            }
            @if (d.status === 'APPROVED') {
              <div class="action-row">
                <app-bronco-button variant="primary" (click)="showImplementedForm.set(true)" [disabled]="saving()">Mark Implemented</app-bronco-button>
                <app-bronco-button variant="secondary" (click)="reopen(d)" [disabled]="saving()">Reopen (→ Proposed)</app-bronco-button>
              </div>
            }
            @if (d.status === 'REJECTED' || d.status === 'DUPLICATE' || d.status === 'IMPLEMENTED') {
              <div class="action-row">
                <app-bronco-button variant="secondary" (click)="reopen(d)" [disabled]="saving()">Reopen (→ Proposed)</app-bronco-button>
              </div>
            }

            @if (showRejectForm()) {
              <div class="form-block">
                <app-form-field label="Reason for rejection">
                  <textarea class="text-input" [(ngModel)]="rejectReason" rows="3" placeholder="Why this request is being declined..."></textarea>
                </app-form-field>
                <div class="action-row">
                  <app-bronco-button variant="destructive" (click)="reject(d)" [disabled]="saving() || !rejectReason.trim()">Confirm Reject</app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="showRejectForm.set(false)">Cancel</app-bronco-button>
                </div>
              </div>
            }

            @if (showDuplicateForm()) {
              <div class="form-block">
                <app-form-field label="Canonical tool request ID">
                  <input class="text-input" [(ngModel)]="duplicateOfId" placeholder="UUID of existing request" />
                </app-form-field>
                <div class="action-row">
                  <app-bronco-button variant="primary" (click)="markDuplicate(d)" [disabled]="saving() || !duplicateOfId.trim()">Confirm Duplicate</app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="showDuplicateForm.set(false)">Cancel</app-bronco-button>
                </div>
              </div>
            }

            @if (showImplementedForm()) {
              <div class="form-block">
                <app-form-field label="Commit SHA (optional)">
                  <input class="text-input" [(ngModel)]="implementedInCommit" placeholder="abc1234" />
                </app-form-field>
                <app-form-field label="GitHub Issue URL (optional)">
                  <input class="text-input" [(ngModel)]="githubIssueUrl" placeholder="https://github.com/owner/repo/issues/123" />
                </app-form-field>
                <div class="action-row">
                  <app-bronco-button variant="primary" (click)="markImplemented(d)" [disabled]="saving()">Mark Implemented</app-bronco-button>
                  <app-bronco-button variant="secondary" (click)="showImplementedForm.set(false)">Cancel</app-bronco-button>
                </div>
              </div>
            }
          </section>

          <section class="danger-section">
            <app-bronco-button variant="destructive" (click)="remove(d)" [disabled]="saving()">Delete Tool Request</app-bronco-button>
          </section>
        </div>
      </app-dialog>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .page-header h1 { margin: 0; font-size: 21px; font-weight: 600; color: var(--text-primary); }
    .page-hint { color: var(--text-tertiary); font-size: 13px; margin: 0 0 16px; }
    .page-hint code { background: var(--bg-muted); padding: 1px 6px; border-radius: 4px; font-size: 12px; }

    .loading-state, .empty-state { padding: 48px; text-align: center; color: var(--text-tertiary); }
    .empty-hint { font-size: 12px; margin-top: 8px; }
    .empty-hint code { background: var(--bg-muted); padding: 1px 5px; border-radius: 4px; }

    .status-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .status-pill.status-proposed { background: rgba(255,204,0,0.15); color: #b58900; border: 1px solid rgba(255,204,0,0.3); }
    .status-pill.status-approved { background: rgba(52,199,89,0.12); color: var(--color-success); border: 1px solid rgba(52,199,89,0.25); }
    .status-pill.status-rejected { background: rgba(255,59,48,0.1); color: var(--color-error); border: 1px solid rgba(255,59,48,0.25); }
    .status-pill.status-implemented { background: rgba(0,122,255,0.1); color: var(--accent); border: 1px solid rgba(0,122,255,0.25); }
    .status-pill.status-duplicate { background: rgba(142,142,147,0.15); color: var(--text-secondary); border: 1px solid rgba(142,142,147,0.3); }

    .title-cell { display: flex; flex-direction: column; gap: 2px; }
    .title { font-weight: 500; color: var(--text-primary); }
    .requested-name { font-family: ui-monospace, monospace; font-size: 11px; color: var(--text-tertiary); }
    .client-name { font-size: 13px; color: var(--text-secondary); }
    .count-pill {
      display: inline-block;
      padding: 1px 8px;
      font-size: 12px;
      background: var(--bg-muted);
      color: var(--text-secondary);
      border-radius: var(--radius-pill);
      font-family: ui-monospace, monospace;
    }
    .time { font-size: 12px; color: var(--text-tertiary); }
    .load-more { display: flex; justify-content: center; margin-top: 16px; }

    .detail { display: flex; flex-direction: column; gap: 16px; }
    .detail-header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .requested-name-big { font-family: ui-monospace, monospace; font-size: 14px; color: var(--text-secondary); }
    .detail section h3 { margin: 0 0 6px; font-size: 13px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
    .body-text { margin: 0; line-height: 1.5; color: var(--text-primary); white-space: pre-wrap; }
    .code-block {
      background: var(--bg-muted);
      padding: 10px 12px;
      border-radius: var(--radius-md);
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .rationale {
      border-left: 2px solid var(--border-light);
      padding: 4px 12px;
      margin-bottom: 10px;
    }
    .rationale-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-tertiary); margin-bottom: 4px; flex-wrap: wrap; }
    .source-tag { background: var(--bg-active); color: var(--accent); padding: 1px 6px; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 10px; }
    .ticket-ref { color: var(--text-secondary); }
    .rationale-text { font-size: 13px; color: var(--text-primary); white-space: pre-wrap; }

    .ticket-list, .dup-list { margin: 0; padding-left: 20px; }
    .ticket-list li, .dup-list li { font-size: 13px; margin-bottom: 4px; }
    .muted { color: var(--text-tertiary); font-size: 11px; }

    .transition-section { border-top: 1px solid var(--border-light); padding-top: 12px; }
    .action-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .form-block { margin-top: 12px; padding: 12px; background: var(--bg-muted); border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 10px; }
    .danger-section { border-top: 1px solid var(--border-light); padding-top: 12px; }
  `],
})
export class ToolRequestListComponent implements OnInit {
  private svc = inject(ToolRequestService);
  private toast = inject(ToastService);

  readonly statusOptions = STATUS_OPTIONS;
  loading = signal(false);
  saving = signal(false);
  items = signal<ToolRequestListItem[]>([]);
  total = signal(0);
  statusFilter = signal<string>('');
  searchInput = signal<string>('');
  offset = signal(0);
  readonly pageSize = 50;

  detail = signal<ToolRequestDetail | null>(null);
  showRejectForm = signal(false);
  showDuplicateForm = signal(false);
  showImplementedForm = signal(false);
  rejectReason = '';
  duplicateOfId = '';
  implementedInCommit = '';
  githubIssueUrl = '';

  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

  hasMore = computed(() => this.total() > this.items().length);

  trackById = (row: ToolRequestListItem) => row.id;

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.offset.set(0);
    this.fetch(false);
  }

  loadMore(): void {
    this.offset.set(this.items().length);
    this.fetch(true);
  }

  private fetch(append: boolean): void {
    this.loading.set(true);
    const status = this.statusFilter();
    this.svc
      .list({
        status: status ? (status as ToolRequestStatus) : undefined,
        search: this.searchInput() || undefined,
        limit: this.pageSize,
        offset: this.offset(),
      })
      .subscribe({
        next: (res) => {
          this.items.set(append ? [...this.items(), ...res.items] : res.items);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => {
          this.toast.error('Failed to load tool requests');
          this.loading.set(false);
        },
      });
  }

  onStatusFilter(value: string): void {
    this.statusFilter.set(value);
    this.refresh();
  }

  onSearchChange(value: string): void {
    this.searchInput.set(value);
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => this.refresh(), 250);
  }

  statusClass(status: string): string {
    return `status-${status.toLowerCase()}`;
  }

  openDetail(row: ToolRequestListItem): void {
    this.svc.get(row.id).subscribe({
      next: (d) => {
        this.resetForms();
        this.detail.set(d);
      },
      error: () => this.toast.error('Failed to load tool request detail'),
    });
  }

  closeDetail(): void {
    this.detail.set(null);
    this.resetForms();
  }

  private resetForms(): void {
    this.showRejectForm.set(false);
    this.showDuplicateForm.set(false);
    this.showImplementedForm.set(false);
    this.rejectReason = '';
    this.duplicateOfId = '';
    this.implementedInCommit = '';
    this.githubIssueUrl = '';
  }

  private applyUpdate(id: string, body: UpdateToolRequestBody, successMsg: string): void {
    this.saving.set(true);
    this.svc.update(id, body).subscribe({
      next: () => {
        this.toast.success(successMsg);
        this.saving.set(false);
        // Reload both the detail and the list row
        this.svc.get(id).subscribe({ next: (d) => this.detail.set(d) });
        this.fetch(false);
      },
      error: (err) => {
        const msg = err?.error?.message ?? 'Failed to update tool request';
        this.toast.error(msg);
        this.saving.set(false);
      },
    });
  }

  approve(d: ToolRequestDetail): void {
    this.applyUpdate(d.id, { status: ToolRequestStatus.APPROVED }, 'Tool request approved');
  }

  reject(d: ToolRequestDetail): void {
    this.applyUpdate(
      d.id,
      { status: ToolRequestStatus.REJECTED, rejectedReason: this.rejectReason.trim() },
      'Tool request rejected',
    );
  }

  markDuplicate(d: ToolRequestDetail): void {
    this.applyUpdate(
      d.id,
      { status: ToolRequestStatus.DUPLICATE, duplicateOfId: this.duplicateOfId.trim() },
      'Marked as duplicate',
    );
  }

  markImplemented(d: ToolRequestDetail): void {
    const body: UpdateToolRequestBody = { status: ToolRequestStatus.IMPLEMENTED };
    if (this.implementedInCommit.trim()) body.implementedInCommit = this.implementedInCommit.trim();
    if (this.githubIssueUrl.trim()) body.githubIssueUrl = this.githubIssueUrl.trim();
    this.applyUpdate(d.id, body, 'Marked implemented');
  }

  reopen(d: ToolRequestDetail): void {
    this.applyUpdate(d.id, { status: ToolRequestStatus.PROPOSED }, 'Tool request reopened');
  }

  remove(d: ToolRequestDetail): void {
    if (!confirm(`Delete tool request "${d.displayTitle}"? This removes its rationale history.`)) return;
    this.saving.set(true);
    this.svc.delete(d.id).subscribe({
      next: () => {
        this.toast.success('Tool request deleted');
        this.saving.set(false);
        this.detail.set(null);
        this.fetch(false);
      },
      error: () => {
        this.toast.error('Failed to delete tool request');
        this.saving.set(false);
      },
    });
  }
}
