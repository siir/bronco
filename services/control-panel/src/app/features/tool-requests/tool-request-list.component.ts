import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, JsonPipe, NgClass } from '@angular/common';
import {
  ToolRequestService,
  ToolRequestStatus,
  type ToolRequestListItem,
  type ToolRequestDetail,
  type UpdateToolRequestBody,
  type SuggestionKind,
} from '../../core/services/tool-request.service.js';
import { ClientService, type Client } from '../../core/services/client.service.js';
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
        <app-bronco-button
          variant="primary"
          size="sm"
          (click)="runDedupe()"
          [disabled]="dedupeRunning() || !clientFilter()">
          {{ dedupeRunning() ? 'Analyzing…' : '⎇ Run Dedupe' }}
        </app-bronco-button>
        <app-bronco-button variant="secondary" size="sm" (click)="refresh()" [disabled]="loading()">
          ↻ Refresh
        </app-bronco-button>
      </div>
    </div>

    <p class="page-hint">
      Agent-flagged capability gaps. Each row represents a missing tool the analyzer wished it had, deduplicated by
      <code>(client, requested_name)</code> with rationale history. Select a client and click Run Dedupe to have Claude propose duplicate/improves-existing suggestions for its PROPOSED/APPROVED requests.
    </p>

    <app-toolbar>
      <app-select
        [value]="clientFilter()"
        [options]="clientOptions()"
        (valueChange)="onClientFilter($event)" />
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
              @if (row.suggestedDuplicateOfId) {
                <span class="suggestion-pill suggestion-duplicate" title="AI dedupe flagged this as a duplicate">⚠ Suggested duplicate</span>
              }
              @if (row.suggestedImprovesExisting) {
                <span class="suggestion-pill suggestion-improves" title="AI dedupe flagged this as improving an existing tool">↗ Improves: {{ row.suggestedImprovesExisting }}</span>
              }
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

          @if (d.suggestedDuplicateOfId || d.suggestedImprovesExisting) {
            <section class="suggestion-section">
              <h3>AI Dedupe Suggestions</h3>
              @if (d.dedupeAnalysisAt) {
                <p class="muted suggestion-when">Last analyzed {{ d.dedupeAnalysisAt | date:'short' }}</p>
              }

              @if (d.suggestedDuplicateOfId) {
                <div class="suggestion-card suggestion-card-duplicate">
                  <div class="suggestion-header">
                    <span class="suggestion-pill suggestion-duplicate">⚠ Suggested duplicate</span>
                    @if (d.suggestedDuplicateOf) {
                      <span class="muted">of {{ d.suggestedDuplicateOf.displayTitle }} ({{ d.suggestedDuplicateOf.requestedName }})</span>
                    }
                  </div>
                  @if (d.suggestedDuplicateReason) {
                    <p class="suggestion-reason">{{ d.suggestedDuplicateReason }}</p>
                  }
                  <div class="action-row">
                    <app-bronco-button variant="primary" size="sm" (click)="acceptSuggestion(d, 'duplicate')" [disabled]="saving()">Accept (→ Duplicate)</app-bronco-button>
                    <app-bronco-button variant="secondary" size="sm" (click)="dismissSuggestion(d, 'duplicate')" [disabled]="saving()">Dismiss</app-bronco-button>
                  </div>
                </div>
              }

              @if (d.suggestedImprovesExisting) {
                <div class="suggestion-card suggestion-card-improves">
                  <div class="suggestion-header">
                    <span class="suggestion-pill suggestion-improves">↗ Improves existing</span>
                    <span class="muted">{{ d.suggestedImprovesExisting }}</span>
                  </div>
                  @if (d.suggestedImprovesReason) {
                    <p class="suggestion-reason">{{ d.suggestedImprovesReason }}</p>
                  }
                  <div class="action-row">
                    <app-bronco-button variant="primary" size="sm" (click)="acceptSuggestion(d, 'improves_existing')" [disabled]="saving()">Accept (→ Rejected)</app-bronco-button>
                    <app-bronco-button variant="secondary" size="sm" (click)="dismissSuggestion(d, 'improves_existing')" [disabled]="saving()">Dismiss</app-bronco-button>
                  </div>
                </div>
              }
            </section>
          }

          @if (d.status === 'APPROVED' && !d.githubIssueUrl) {
            <section class="github-section">
              <h3>Create GitHub Issue</h3>
              <p class="muted">Opens an issue in the configured default repo (or override below) and saves the link on this request.</p>
              <div class="form-block">
                <app-form-field label="Repo owner (optional override)">
                  <input class="text-input" [(ngModel)]="ghRepoOwner" placeholder="e.g. siir" />
                </app-form-field>
                <app-form-field label="Repo name (optional override)">
                  <input class="text-input" [(ngModel)]="ghRepoName" placeholder="e.g. bronco" />
                </app-form-field>
                <app-form-field label="Labels (comma-separated, optional)">
                  <input class="text-input" [(ngModel)]="ghLabels" placeholder="tool-request, enhancement" />
                </app-form-field>
                <div class="action-row">
                  <app-bronco-button variant="primary" (click)="createGithubIssue(d)" [disabled]="ghCreating()">
                    {{ ghCreating() ? 'Creating…' : 'Create GitHub Issue' }}
                  </app-bronco-button>
                </div>
              </div>
            </section>
          }

          @if (d.githubIssueUrl) {
            <section class="github-section">
              <h3>GitHub Issue</h3>
              <p><a [href]="d.githubIssueUrl" target="_blank" rel="noopener">{{ d.githubIssueUrl }}</a></p>
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

    .title-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .title {
      font-weight: 500; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .requested-name {
      font-family: ui-monospace, monospace; font-size: 11px; color: var(--text-tertiary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* Respect column widths so the flex Title column truncates long tool
     * names/titles instead of pushing Client/Count/Updated off the right. */
    :host ::ng-deep app-data-table table {
      table-layout: fixed;
    }
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

    .suggestion-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-weight: 600;
      margin-left: 4px;
      white-space: nowrap;
    }
    .suggestion-pill.suggestion-duplicate { background: rgba(255,204,0,0.15); color: #b58900; border: 1px solid rgba(255,204,0,0.35); }
    .suggestion-pill.suggestion-improves { background: rgba(0,122,255,0.12); color: var(--accent); border: 1px solid rgba(0,122,255,0.25); }

    .suggestion-section { border-top: 1px solid var(--border-light); padding-top: 12px; }
    .suggestion-when { margin: -4px 0 8px; font-size: 11px; }
    .suggestion-card {
      padding: 10px 12px;
      border-radius: var(--radius-md);
      margin-bottom: 10px;
      border: 1px solid var(--border-light);
    }
    .suggestion-card-duplicate { background: rgba(255,204,0,0.04); border-color: rgba(255,204,0,0.2); }
    .suggestion-card-improves { background: rgba(0,122,255,0.03); border-color: rgba(0,122,255,0.2); }
    .suggestion-header { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
    .suggestion-reason { margin: 4px 0 8px; font-size: 13px; color: var(--text-primary); white-space: pre-wrap; }

    .github-section { border-top: 1px solid var(--border-light); padding-top: 12px; }
    .github-section a { color: var(--accent); word-break: break-all; }
  `],
})
export class ToolRequestListComponent implements OnInit {
  private svc = inject(ToolRequestService);
  private clientSvc = inject(ClientService);
  private toast = inject(ToastService);

  readonly statusOptions = STATUS_OPTIONS;
  loading = signal(false);
  saving = signal(false);
  items = signal<ToolRequestListItem[]>([]);
  total = signal(0);
  statusFilter = signal<string>('');
  clientFilter = signal<string>('');
  searchInput = signal<string>('');
  offset = signal(0);
  readonly pageSize = 50;

  clients = signal<Client[]>([]);
  clientOptions = computed(() => [
    { value: '', label: 'All Clients' },
    ...this.clients().map((c) => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
  ]);

  dedupeRunning = signal(false);

  detail = signal<ToolRequestDetail | null>(null);
  showRejectForm = signal(false);
  showDuplicateForm = signal(false);
  showImplementedForm = signal(false);
  rejectReason = '';
  duplicateOfId = '';
  implementedInCommit = '';
  githubIssueUrl = '';

  ghRepoOwner = '';
  ghRepoName = '';
  ghLabels = '';
  ghCreating = signal(false);

  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

  hasMore = computed(() => this.total() > this.items().length);

  trackById = (row: ToolRequestListItem) => row.id;

  ngOnInit(): void {
    this.clientSvc.getClients().subscribe({
      next: (list) => this.clients.set(list),
      error: () => {
        /* non-fatal — client filter stays empty */
      },
    });
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
        clientId: this.clientFilter() || undefined,
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

  onClientFilter(value: string): void {
    this.clientFilter.set(value);
    this.refresh();
  }

  runDedupe(): void {
    const clientId = this.clientFilter();
    if (!clientId) {
      this.toast.error('Select a client first');
      return;
    }
    this.dedupeRunning.set(true);
    this.svc.runDedupeAnalysis(clientId).subscribe({
      next: (res) => {
        this.dedupeRunning.set(false);
        const warn = res.warnings?.length ? ` (${res.warnings.length} warning${res.warnings.length === 1 ? '' : 's'})` : '';
        this.toast.success(
          `Dedupe complete: ${res.duplicateGroupsCount} duplicate group(s), ${res.improvesExistingCount} improves-existing across ${res.requestsAnalyzed} request(s)${warn}`,
        );
        this.refresh();
      },
      error: (err) => {
        this.dedupeRunning.set(false);
        const msg = err?.error?.message ?? 'Dedupe analysis failed';
        this.toast.error(msg);
      },
    });
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
    this.ghRepoOwner = '';
    this.ghRepoName = '';
    this.ghLabels = '';
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

  acceptSuggestion(d: ToolRequestDetail, kind: SuggestionKind): void {
    this.saving.set(true);
    this.svc.acceptSuggestion(d.id, kind).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.detail.set(updated);
        this.toast.success(kind === 'duplicate' ? 'Accepted — marked as duplicate' : 'Accepted — marked rejected (improves existing)');
        this.fetch(false);
      },
      error: (err) => {
        this.saving.set(false);
        const msg = err?.error?.message ?? 'Failed to accept suggestion';
        this.toast.error(msg);
      },
    });
  }

  dismissSuggestion(d: ToolRequestDetail, kind: SuggestionKind): void {
    this.saving.set(true);
    this.svc.dismissSuggestion(d.id, kind).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.detail.set(updated);
        this.toast.success('Suggestion dismissed');
        this.fetch(false);
      },
      error: (err) => {
        this.saving.set(false);
        const msg = err?.error?.message ?? 'Failed to dismiss suggestion';
        this.toast.error(msg);
      },
    });
  }

  createGithubIssue(d: ToolRequestDetail): void {
    this.ghCreating.set(true);
    const opts: { repoOwner?: string; repoName?: string; labels?: string[] } = {};
    if (this.ghRepoOwner.trim()) opts.repoOwner = this.ghRepoOwner.trim();
    if (this.ghRepoName.trim()) opts.repoName = this.ghRepoName.trim();
    const labels = this.ghLabels
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    if (labels.length > 0) opts.labels = labels;

    this.svc.createGithubIssue(d.id, opts).subscribe({
      next: (res) => {
        this.ghCreating.set(false);
        this.toast.success(`Created GitHub issue #${res.issueNumber}`);
        this.svc.get(d.id).subscribe({ next: (refreshed) => this.detail.set(refreshed) });
        this.fetch(false);
      },
      error: (err) => {
        this.ghCreating.set(false);
        const msg = err?.error?.message ?? 'Failed to create GitHub issue';
        this.toast.error(msg);
      },
    });
  }
}
