import { Component, inject, OnInit, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatChipsModule } from '@angular/material/chips';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { Subject, EMPTY, switchMap, timer } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import { EmailLogService, EmailProcessingLog, EmailLogStats } from '../../core/services/email-log.service';

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatChipsModule,
    MatPaginatorModule,
    MatTooltipModule,
    MatMenuModule,
    MatSnackBarModule,
  ],
  template: `
    <div class="page-header">
      <h1>Email Processing Log</h1>
      <button mat-raised-button (click)="load()">
        <mat-icon>refresh</mat-icon> Refresh
      </button>
    </div>

    <!-- Stats cards -->
    <div class="stats-row">
      <mat-card class="stat-card">
        <mat-card-content>
          <div class="stat-value">{{ stats().totalToday }}</div>
          <div class="stat-label">Processed Today</div>
        </mat-card-content>
      </mat-card>
      <mat-card class="stat-card">
        <mat-card-content>
          <div class="stat-value">{{ stats().ticketsCreated }}</div>
          <div class="stat-label">Tickets Created</div>
        </mat-card-content>
      </mat-card>
      <mat-card class="stat-card">
        <mat-card-content>
          <div class="stat-value">{{ stats().noiseFiltered }}</div>
          <div class="stat-label">Noise Filtered</div>
        </mat-card-content>
      </mat-card>
      <mat-card class="stat-card" [class.stat-alert]="stats().failures > 0">
        <mat-card-content>
          <div class="stat-value">{{ stats().failures }}</div>
          <div class="stat-label">Failures</div>
        </mat-card-content>
      </mat-card>
    </div>

    <!-- Filters -->
    <div class="filters">
      <mat-form-field>
        <mat-label>Classification</mat-label>
        <mat-select [(ngModel)]="classificationFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All</mat-option>
          <mat-option value="TICKET_WORTHY">Ticket Worthy</mat-option>
          <mat-option value="THREAD_REPLY">Thread Reply</mat-option>
          <mat-option value="NOISE">Noise</mat-option>
          <mat-option value="AUTO_REPLY">Auto Reply</mat-option>
        </mat-select>
      </mat-form-field>

      <mat-form-field>
        <mat-label>Status</mat-label>
        <mat-select [(ngModel)]="statusFilter" (ngModelChange)="resetAndLoad()">
          <mat-option value="">All</mat-option>
          <mat-option value="processed">Processed</mat-option>
          <mat-option value="failed">Failed</mat-option>
          <mat-option value="retried">Retried</mat-option>
          <mat-option value="discarded">Discarded</mat-option>
        </mat-select>
      </mat-form-field>
    </div>

    <!-- Table -->
    <mat-card>
      <table mat-table [dataSource]="logs()" class="full-width" multiTemplateDataRows>
        <ng-container matColumnDef="from">
          <th mat-header-cell *matHeaderCellDef>From</th>
          <td mat-cell *matCellDef="let log">
            <div class="from-cell">
              <span class="from-name">{{ log.fromName || log.from }}</span>
              @if (log.fromName && log.fromName !== log.from) {
                <span class="from-address">{{ log.from }}</span>
              }
            </div>
          </td>
        </ng-container>

        <ng-container matColumnDef="subject">
          <th mat-header-cell *matHeaderCellDef>Subject</th>
          <td mat-cell *matCellDef="let log" class="subject-cell">{{ log.subject }}</td>
        </ng-container>

        <ng-container matColumnDef="classification">
          <th mat-header-cell *matHeaderCellDef>Classification</th>
          <td mat-cell *matCellDef="let log">
            <span class="badge badge-{{ log.classification.toLowerCase() }}">{{ formatClassification(log.classification) }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let log">
            <span class="badge status-{{ log.status }}">{{ log.status }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="client">
          <th mat-header-cell *matHeaderCellDef>Client</th>
          <td mat-cell *matCellDef="let log">
            @if (log.client) {
              <a [routerLink]="['/clients', log.client.id]">{{ log.client.name }}</a>
            } @else {
              <span class="muted">—</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="ticket">
          <th mat-header-cell *matHeaderCellDef>Ticket</th>
          <td mat-cell *matCellDef="let log">
            @if (log.ticket) {
              <a [routerLink]="['/tickets', log.ticket.id]" [matTooltip]="log.ticket.subject">{{ log.ticket.subject | slice:0:30 }}{{ log.ticket.subject.length > 30 ? '...' : '' }}</a>
            } @else {
              <span class="muted">—</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="received">
          <th mat-header-cell *matHeaderCellDef>Received</th>
          <td mat-cell *matCellDef="let log" class="time-cell">{{ formatTime(log.receivedAt ?? log.createdAt) }}</td>
        </ng-container>

        <ng-container matColumnDef="processingMs">
          <th mat-header-cell *matHeaderCellDef>Time</th>
          <td mat-cell *matCellDef="let log">
            @if (log.processingMs !== null) {
              {{ log.processingMs }}ms
            } @else {
              <span class="muted">—</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let log">
            <button mat-icon-button [matMenuTriggerFor]="menu" (click)="$event.stopPropagation()">
              <mat-icon>more_vert</mat-icon>
            </button>
            <mat-menu #menu="matMenu">
              @if (log.status === 'failed' || log.classification === 'NOISE' || log.classification === 'AUTO_REPLY') {
                <button mat-menu-item (click)="retryEmail(log)">
                  <mat-icon>replay</mat-icon> Retry
                </button>
              }
              <button mat-menu-item [matMenuTriggerFor]="reclassifyMenu">
                <mat-icon>label</mat-icon> Reclassify
              </button>
              <button mat-menu-item (click)="toggleExpand(log.id)">
                <mat-icon>info</mat-icon> Details
              </button>
            </mat-menu>
            <mat-menu #reclassifyMenu="matMenu">
              <button mat-menu-item (click)="reclassify(log, 'TICKET_WORTHY')">Ticket Worthy</button>
              <button mat-menu-item (click)="reclassify(log, 'THREAD_REPLY')">Thread Reply</button>
              <button mat-menu-item (click)="reclassify(log, 'NOISE')">Noise</button>
              <button mat-menu-item (click)="reclassify(log, 'AUTO_REPLY')">Auto Reply</button>
            </mat-menu>
          </td>
        </ng-container>

        <!-- Expanded detail row -->
        <ng-container matColumnDef="expandedDetail">
          <td mat-cell *matCellDef="let log" [attr.colspan]="columns.length">
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
                  @if (log.metadata['references']?.length) {
                    <div class="detail-section">
                      <div class="detail-label">References</div>
                      <code>{{ log.metadata['references'].join(', ') }}</code>
                    </div>
                  }
                  @if (log.metadata['body']) {
                    <div class="detail-section">
                      <div class="detail-label">Body Preview</div>
                      <pre class="body-preview">{{ log.metadata['body'] | slice:0:1000 }}</pre>
                    </div>
                  }
                }
              </div>
            }
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let log; columns: columns;" class="log-row" (click)="toggleExpand(log.id)"></tr>
        <tr mat-row *matRowDef="let log; columns: ['expandedDetail'];" class="detail-row"></tr>
      </table>

      <mat-paginator
        [length]="total()"
        [pageSize]="pageSize"
        [pageSizeOptions]="[50, 100, 200]"
        (page)="onPage($event)"
        showFirstLastButtons>
      </mat-paginator>
    </mat-card>
  `,
  styles: [`
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .page-header h1 { margin: 0; font-size: 24px; font-weight: 400; }
    .stats-row {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .stat-card {
      flex: 1;
      min-width: 140px;
      text-align: center;
    }
    .stat-value { font-size: 28px; font-weight: 500; }
    .stat-label { font-size: 13px; color: #666; margin-top: 4px; }
    .stat-alert { border-left: 4px solid #f44336; }
    .stat-alert .stat-value { color: #f44336; }
    .filters {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .filters mat-form-field { width: 180px; }
    .full-width { width: 100%; }
    .from-cell { display: flex; flex-direction: column; }
    .from-name { font-weight: 500; font-size: 13px; }
    .from-address { font-size: 11px; color: #888; }
    .subject-cell { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .time-cell { white-space: nowrap; font-size: 12px; color: #666; }
    .muted { color: #ccc; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
    }
    .badge-ticket_worthy { background: #e8f5e9; color: #2e7d32; }
    .badge-thread_reply { background: #e3f2fd; color: #1565c0; }
    .badge-noise { background: #fafafa; color: #9e9e9e; }
    .badge-auto_reply { background: #fff3e0; color: #e65100; }
    .status-processed { background: #e8f5e9; color: #2e7d32; }
    .status-failed { background: #ffebee; color: #c62828; }
    .status-retried { background: #fff3e0; color: #e65100; }
    .status-discarded { background: #fafafa; color: #9e9e9e; }
    .log-row { cursor: pointer; }
    .log-row:hover { background: #f5f5f5; }
    .detail-row { height: 0; }
    .detail-panel { padding: 16px 24px; background: #fafafa; border-bottom: 1px solid #e0e0e0; }
    .detail-section { margin-bottom: 12px; }
    .detail-label { font-weight: 500; font-size: 12px; color: #666; margin-bottom: 4px; }
    .error-block pre { color: #c62828; background: #fff5f5; padding: 8px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .body-preview { background: #fff; border: 1px solid #e0e0e0; padding: 8px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
    code { font-size: 12px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
  `],
})
export class EmailLogComponent implements OnInit, OnDestroy {
  private emailLogService = inject(EmailLogService);
  private snackBar = inject(MatSnackBar);
  private destroy$ = new Subject<void>();

  logs = signal<EmailProcessingLog[]>([]);
  total = signal(0);
  stats = signal<EmailLogStats>({ totalToday: 0, ticketsCreated: 0, noiseFiltered: 0, failures: 0 });
  expandedId = signal<string | null>(null);

  classificationFilter = '';
  statusFilter = '';
  pageSize = 100;
  pageIndex = 0;

  columns = ['from', 'subject', 'classification', 'status', 'client', 'ticket', 'received', 'processingMs', 'actions'];

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
          this.snackBar.open('Failed to load email logs. Please try again.', 'Dismiss', { duration: 5000 });
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
          this.snackBar.open('Failed to load email log stats. Please try again.', 'Dismiss', { duration: 5000 });
          return EMPTY;
        }),
      )
      .subscribe((s) => this.stats.set(s));
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

  toggleExpand(id: string): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  retryEmail(log: EmailProcessingLog): void {
    this.emailLogService.retry(log.id).subscribe({
      next: (res) => {
        this.snackBar.open(res.message, 'OK', { duration: 4000 });
        this.load();
      },
      error: (err) => this.snackBar.open(err.error?.error ?? 'Retry failed', 'OK', { duration: 4000 }),
    });
  }

  reclassify(log: EmailProcessingLog, classification: string): void {
    this.emailLogService.reclassify(log.id, classification).subscribe({
      next: () => {
        this.snackBar.open('Classification updated', 'OK', { duration: 3000 });
        this.load();
      },
      error: (err) => this.snackBar.open(err.error?.error ?? 'Update failed', 'OK', { duration: 4000 }),
    });
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  }

  formatClassification(c: string): string {
    return c.replace(/_/g, ' ');
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
