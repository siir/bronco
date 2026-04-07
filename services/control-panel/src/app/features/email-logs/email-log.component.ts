import { Component, inject, OnInit, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, EMPTY, switchMap, timer } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import { EmailLogService, EmailProcessingLog, EmailLogStats } from '../../core/services/email-log.service';
import {
  BroncoButtonComponent,
  SelectComponent,
  StatCardComponent,
  DataTableComponent,
  DataTableColumnComponent,
  PaginatorComponent,
  type PaginatorPageEvent,
  DropdownMenuComponent,
  DropdownItemComponent,
  DropdownDividerComponent,
  DropdownLabelComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    BroncoButtonComponent,
    SelectComponent,
    StatCardComponent,
    DataTableComponent,
    DataTableColumnComponent,
    PaginatorComponent,
    DropdownMenuComponent,
    DropdownItemComponent,
    DropdownDividerComponent,
    DropdownLabelComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1>Email Processing Log</h1>
        <app-bronco-button variant="secondary" (click)="load()">Refresh</app-bronco-button>
      </div>

      <!-- Stats cards -->
      <div class="stats-row">
        <app-stat-card label="Processed Today" [value]="'' + stats().totalToday"></app-stat-card>
        <app-stat-card label="Tickets Created" [value]="'' + stats().ticketsCreated"></app-stat-card>
        <app-stat-card label="Noise Filtered" [value]="'' + stats().noiseFiltered"></app-stat-card>
        <app-stat-card
          label="Failures"
          [value]="'' + stats().failures"
          [changeType]="stats().failures > 0 ? 'negative' : 'neutral'">
        </app-stat-card>
      </div>

      <!-- Filters -->
      <div class="filters">
        <app-select
          [value]="classificationFilter"
          [options]="classificationOptions"
          placeholder=""
          (valueChange)="classificationFilter = $event; resetAndLoad()">
        </app-select>
        <app-select
          [value]="statusFilter"
          [options]="statusOptions"
          placeholder="Status"
          (valueChange)="statusFilter = $event; resetAndLoad()">
        </app-select>
      </div>

      <!-- Table -->
      <div class="table-card">
        <app-data-table [data]="logs()" [trackBy]="trackById" [rowClickable]="true" (rowClick)="toggleExpand($event.id)" emptyMessage="No email logs found.">
          <app-data-column key="from" header="From" [sortable]="false">
            <ng-template #cell let-log>
              <div class="from-cell">
                <span class="from-name">{{ log.fromName || log.from }}</span>
                @if (log.fromName && log.fromName !== log.from) {
                  <span class="from-address">{{ log.from }}</span>
                }
              </div>
            </ng-template>
          </app-data-column>

          <app-data-column key="subject" header="Subject" [sortable]="false" width="300px">
            <ng-template #cell let-log>
              <span class="subject-text">{{ log.subject }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="classification" header="Classification" [sortable]="false">
            <ng-template #cell let-log>
              <span class="badge badge-{{ log.classification.toLowerCase() }}">{{ formatClassification(log.classification) }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="status" header="Status" [sortable]="false">
            <ng-template #cell let-log>
              <span class="badge status-{{ log.status }}">{{ log.status }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="client" header="Client" [sortable]="false">
            <ng-template #cell let-log>
              @if (log.client) {
                <a class="link" [routerLink]="['/clients', log.client.id]">{{ log.client.name }}</a>
              } @else {
                <span class="muted">—</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="ticket" header="Ticket" [sortable]="false">
            <ng-template #cell let-log>
              @if (log.ticket) {
                <a class="link" [routerLink]="['/tickets', log.ticket.id]" [title]="log.ticket.subject">{{ log.ticket.subject | slice:0:30 }}{{ log.ticket.subject.length > 30 ? '...' : '' }}</a>
              } @else {
                <span class="muted">—</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="received" header="Received" [sortable]="false">
            <ng-template #cell let-log>
              <span class="time-cell">{{ formatTime(log.receivedAt ?? log.createdAt) }}</span>
            </ng-template>
          </app-data-column>

          <app-data-column key="processingMs" header="Time" [sortable]="false">
            <ng-template #cell let-log>
              @if (log.processingMs !== null) {
                {{ log.processingMs }}ms
              } @else {
                <span class="muted">—</span>
              }
            </ng-template>
          </app-data-column>

          <app-data-column key="actions" header="" [sortable]="false" width="48px">
            <ng-template #cell let-log>
              <button type="button" class="icon-btn" aria-label="Open actions menu" #menuTrigger (click)="$event.stopPropagation(); menu.toggle()">···</button>
              <app-dropdown-menu #menu [trigger]="menuTrigger">
                @if (log.status === 'failed' || log.classification === 'NOISE' || log.classification === 'AUTO_REPLY') {
                  <app-dropdown-item (action)="retryEmail(log)">Retry</app-dropdown-item>
                }
                <app-dropdown-item (action)="toggleExpand(log.id)">Details</app-dropdown-item>
                <app-dropdown-divider />
                <app-dropdown-label>Reclassify as:</app-dropdown-label>
                <app-dropdown-item (action)="reclassify(log, 'TICKET_WORTHY')">Ticket Worthy</app-dropdown-item>
                <app-dropdown-item (action)="reclassify(log, 'THREAD_REPLY')">Thread Reply</app-dropdown-item>
                <app-dropdown-item (action)="reclassify(log, 'NOISE')">Noise</app-dropdown-item>
                <app-dropdown-item (action)="reclassify(log, 'AUTO_REPLY')">Auto Reply</app-dropdown-item>
              </app-dropdown-menu>
            </ng-template>
          </app-data-column>
        </app-data-table>

        <!-- Expanded detail -->
        @for (log of logs(); track log.id) {
          @if (expandedId() === log.id) {
            <div class="detail-panel">
              @if (log.errorMessage) {
                <div class="detail-section error-block">
                  <div class="detail-label">Error</div>
                  <pre>{{ log.errorMessage }}</pre>
                </div>
              }
              <div class="detail-section">
                <div class="detail-label">Message ID</div>
                <code>{{ log.messageId }}</code>
              </div>
              @if (log.metadata) {
                @if (log.metadata['inReplyTo']) {
                  <div class="detail-section">
                    <div class="detail-label">In-Reply-To</div>
                    <code>{{ log.metadata['inReplyTo'] }}</code>
                  </div>
                }
                @if (asArray(log.metadata['references']).length) {
                  <div class="detail-section">
                    <div class="detail-label">References</div>
                    <code>{{ asArray(log.metadata['references']).join(', ') }}</code>
                  </div>
                }
                @if (log.metadata['body']) {
                  <div class="detail-section">
                    <div class="detail-label">Body Preview</div>
                    <pre class="body-preview">{{ asString(log.metadata['body']) | slice:0:1000 }}</pre>
                  </div>
                }
              }
            </div>
          }
        }

        <app-paginator
          [length]="total()"
          [pageSize]="pageSize"
          [pageIndex]="pageIndex"
          [pageSizeOptions]="[50, 100, 200]"
          (page)="onPage($event)" />
      </div>
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .page-header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
      font-family: var(--font-primary);
      color: var(--text-primary);
      letter-spacing: -0.28px;
      line-height: 1.14;
    }
    .stats-row {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .stats-row app-stat-card { flex: 1; min-width: 140px; }
    .filters {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .table-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      overflow: hidden;
    }
    .from-cell { display: flex; flex-direction: column; }
    .from-name { font-weight: 500; font-size: 13px; color: var(--text-primary); }
    .from-address { font-size: 11px; color: var(--text-tertiary); }
    .subject-text { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; color: var(--text-secondary); }
    .time-cell { white-space: nowrap; font-size: 12px; color: var(--text-tertiary); font-family: var(--font-primary); }
    .muted { color: var(--text-tertiary); }
    .link { text-decoration: none; color: var(--accent-link); font-weight: 500; }
    .link:hover { text-decoration: underline; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      font-family: var(--font-primary);
      letter-spacing: -0.08px;
    }
    .badge-ticket_worthy { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .badge-thread_reply { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .badge-noise { background: var(--bg-muted); color: var(--text-tertiary); }
    .badge-auto_reply { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .status-processed { background: rgba(52, 199, 89, 0.1); color: var(--color-success); }
    .status-failed { background: rgba(255, 59, 48, 0.1); color: var(--color-error); }
    .status-retried { background: rgba(255, 149, 0, 0.1); color: var(--color-warning); }
    .status-discarded { background: var(--bg-muted); color: var(--text-tertiary); }
    .icon-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      color: var(--text-tertiary);
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      letter-spacing: 1px;
      font-weight: 700;
    }
    .icon-btn:hover { background: var(--bg-hover); }
    .detail-panel {
      padding: 16px 24px;
      background: var(--bg-page);
      border-top: 1px solid var(--border-light);
      border-bottom: 1px solid var(--border-light);
    }
    .detail-section { margin-bottom: 12px; }
    .detail-label {
      font-weight: 600;
      font-size: 12px;
      color: var(--text-tertiary);
      margin-bottom: 4px;
      font-family: var(--font-primary);
      letter-spacing: -0.12px;
    }
    .error-block pre {
      color: var(--color-error);
      background: rgba(255, 59, 48, 0.06);
      padding: 8px;
      border-radius: var(--radius-md);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
    }
    .body-preview {
      background: var(--bg-card);
      border: 1px solid var(--border-light);
      padding: 8px;
      border-radius: var(--radius-md);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
      margin: 0;
    }
    code {
      font-size: 12px;
      background: var(--bg-muted);
      padding: 2px 6px;
      border-radius: var(--radius-sm);
    }
  `],
})
export class EmailLogComponent implements OnInit, OnDestroy {
  private emailLogService = inject(EmailLogService);
  private toast = inject(ToastService);
  private destroy$ = new Subject<void>();

  logs = signal<EmailProcessingLog[]>([]);
  total = signal(0);
  stats = signal<EmailLogStats>({ totalToday: 0, ticketsCreated: 0, noiseFiltered: 0, failures: 0 });
  expandedId = signal<string | null>(null);

  classificationFilter = '';
  statusFilter = '';
  pageSize = 100;
  pageIndex = 0;

  classificationOptions = [
    { value: '', label: 'All' },
    { value: 'TICKET_WORTHY', label: 'Ticket Worthy' },
    { value: 'THREAD_REPLY', label: 'Thread Reply' },
    { value: 'NOISE', label: 'Noise' },
    { value: 'AUTO_REPLY', label: 'Auto Reply' },
  ];

  statusOptions = [
    { value: '', label: 'All' },
    { value: 'processed', label: 'Processed' },
    { value: 'failed', label: 'Failed' },
    { value: 'retried', label: 'Retried' },
    { value: 'discarded', label: 'Discarded' },
  ];

  trackById = (log: EmailProcessingLog) => log.id;

  ngOnInit(): void {
    this.load();
    this.loadStats();

    // Auto-refresh every 30 seconds
    timer(30_000, 30_000)
      .pipe(
        takeUntil(this.destroy$),
        switchMap(() => this.emailLogService.getLogs(this.buildFilters()).pipe(catchError(() => EMPTY))),
      )
      .subscribe((res) => {
        this.logs.set(res.logs);
        this.total.set(res.total);
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  load(): void {
    this.emailLogService
      .getLogs(this.buildFilters())
      .pipe(
        catchError(() => {
          this.toast.error('Failed to load email logs. Please try again.');
          return EMPTY;
        }),
      )
      .subscribe((res) => {
        this.logs.set(res.logs);
        this.total.set(res.total);
      });
    this.loadStats();
  }

  loadStats(): void {
    this.emailLogService
      .getStats()
      .pipe(
        catchError(() => {
          this.toast.error('Failed to load email log stats. Please try again.');
          return EMPTY;
        }),
      )
      .subscribe((s) => this.stats.set(s));
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

  toggleExpand(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  retryEmail(log: EmailProcessingLog): void {
    this.emailLogService.retry(log.id).subscribe({
      next: (res) => {
        this.toast.info(res.message);
        this.load();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Retry failed'),
    });
  }

  reclassify(log: EmailProcessingLog, classification: string): void {
    this.emailLogService.reclassify(log.id, classification).subscribe({
      next: () => {
        this.toast.success('Classification updated');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Update failed'),
    });
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  }

  formatClassification(c: string): string {
    return c.replace(/_/g, ' ');
  }

  asArray(val: unknown): string[] {
    return Array.isArray(val) ? val : [];
  }

  asString(val: unknown): string {
    return typeof val === 'string' ? val : String(val ?? '');
  }

  private buildFilters(): Record<string, string | number> {
    return {
      ...(this.classificationFilter && { classification: this.classificationFilter }),
      ...(this.statusFilter && { status: this.statusFilter }),
      limit: this.pageSize,
      offset: this.pageIndex * this.pageSize,
    };
  }
}
