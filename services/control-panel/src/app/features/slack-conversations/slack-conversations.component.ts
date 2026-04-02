import { Component, inject, OnInit, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subject, EMPTY } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import {
  SlackConversationService,
  SlackConversationSummary,
  SlackConversationDetail,
} from '../../core/services/slack-conversation.service';
import { ClientService, Client } from '../../core/services/client.service';

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatInputModule,
    MatPaginatorModule,
    MatSnackBarModule,
    MatChipsModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <div class="page-header">
      <h1>Slack Conversations</h1>
      <button mat-raised-button (click)="load()">
        <mat-icon>refresh</mat-icon> Refresh
      </button>
    </div>

    <!-- Filters -->
    <mat-card class="filter-card">
      <mat-card-content>
        <div class="filter-row">
          <mat-form-field appearance="outline">
            <mat-label>Client</mat-label>
            <mat-select [(ngModel)]="clientFilter" (selectionChange)="resetAndLoad()">
              <mat-option value="">All Clients</mat-option>
              @for (c of clients(); track c.id) {
                <mat-option [value]="c.id">{{ c.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Start Date</mat-label>
            <input matInput type="date" [(ngModel)]="startDate" (change)="resetAndLoad()" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>End Date</mat-label>
            <input matInput type="date" [(ngModel)]="endDate" (change)="resetAndLoad()" />
          </mat-form-field>
        </div>
      </mat-card-content>
    </mat-card>

    <!-- Table -->
    <mat-card>
      <table mat-table [dataSource]="conversations()" multiTemplateDataRows class="full-width">
        <ng-container matColumnDef="operator">
          <th mat-header-cell *matHeaderCellDef>Operator</th>
          <td mat-cell *matCellDef="let row">{{ row.operator.name }}</td>
        </ng-container>
        <ng-container matColumnDef="client">
          <th mat-header-cell *matHeaderCellDef>Client</th>
          <td mat-cell *matCellDef="let row">{{ row.client?.name ?? '—' }}</td>
        </ng-container>
        <ng-container matColumnDef="channel">
          <th mat-header-cell *matHeaderCellDef>Channel</th>
          <td mat-cell *matCellDef="let row"><code>{{ row.channelId }}</code></td>
        </ng-container>
        <ng-container matColumnDef="messages">
          <th mat-header-cell *matHeaderCellDef>Messages</th>
          <td mat-cell *matCellDef="let row">{{ row.messageCount }}</td>
        </ng-container>
        <ng-container matColumnDef="tokens">
          <th mat-header-cell *matHeaderCellDef>Tokens</th>
          <td mat-cell *matCellDef="let row">
            @if (row.totalInputTokens || row.totalOutputTokens) {
              {{ (row.totalInputTokens ?? 0) + (row.totalOutputTokens ?? 0) | number }}
            } @else {
              —
            }
          </td>
        </ng-container>
        <ng-container matColumnDef="started">
          <th mat-header-cell *matHeaderCellDef>Started</th>
          <td mat-cell *matCellDef="let row">{{ formatTime(row.createdAt) }}</td>
        </ng-container>
        <ng-container matColumnDef="updated">
          <th mat-header-cell *matHeaderCellDef>Last Activity</th>
          <td mat-cell *matCellDef="let row">{{ formatTime(row.updatedAt) }}</td>
        </ng-container>

        <!-- Expanded detail row -->
        <ng-container matColumnDef="expandedDetail">
          <td mat-cell *matCellDef="let row" [attr.colspan]="columns.length">
            @if (expandedId() === row.id) {
              <div class="detail-panel">
                @if (loadingDetail()) {
                  <mat-spinner diameter="24"></mat-spinner>
                } @else if (detail()) {
                  <!-- Cost summary -->
                  <div class="cost-summary">
                    <span class="cost-chip">Input: {{ detail()!.totalInputTokens ?? 0 | number }} tokens</span>
                    <span class="cost-chip">Output: {{ detail()!.totalOutputTokens ?? 0 | number }} tokens</span>
                  </div>

                  <!-- Messages -->
                  <div class="chat-container">
                    @for (msg of detail()!.messages; track $index) {
                      <div class="chat-msg" [class.user-msg]="msg.role === 'user'" [class.assistant-msg]="msg.role === 'assistant'">
                        <div class="msg-role">{{ msg.role === 'user' ? detail()!.operator.name : 'Hugo' }}</div>
                        <div class="msg-content">{{ msg.content }}</div>
                        <div class="msg-time">{{ formatTime(msg.timestamp) }}</div>
                      </div>
                    }
                  </div>

                  <!-- Tool calls -->
                  @if (detail()!.toolCalls?.length) {
                    <h4>Tool Calls</h4>
                    <div class="tool-calls">
                      @for (tc of detail()!.toolCalls; track $index) {
                        <div class="tool-card" [class.tool-error]="tc.isError">
                          <div class="tool-header">
                            <code>{{ tc.tool }}</code>
                            <span class="tool-duration">{{ tc.durationMs }}ms</span>
                            @if (tc.isError) {
                              <mat-icon class="tool-error-icon">error</mat-icon>
                            }
                          </div>
                          <div class="tool-result">{{ tc.resultPreview }}</div>
                        </div>
                      }
                    </div>
                  }
                }
              </div>
            }
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns" class="conv-row" (click)="toggleExpand(row.id)"></tr>
        <tr mat-row *matRowDef="let row; columns: ['expandedDetail']" class="detail-row"></tr>
      </table>

      <mat-paginator
        [length]="total()"
        [pageSize]="pageSize"
        [pageSizeOptions]="[25, 50, 100]"
        (page)="onPage($event)"
        showFirstLastButtons>
      </mat-paginator>
    </mat-card>
  `,
  styles: [`
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .page-header h1 { margin: 0; font-size: 24px; }
    .filter-card { margin-bottom: 16px; }
    .filter-row { display: flex; gap: 16px; flex-wrap: wrap; }
    .filter-row mat-form-field { min-width: 180px; }
    .full-width { width: 100%; }
    code { font-size: 12px; background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    .conv-row { cursor: pointer; }
    .conv-row:hover { background: #f5f5f5; }
    .detail-row { height: 0; }
    .detail-panel { padding: 16px 24px; background: #fafafa; border-bottom: 1px solid #e0e0e0; }
    .cost-summary { display: flex; gap: 12px; margin-bottom: 16px; }
    .cost-chip { background: #e3f2fd; color: #1565c0; padding: 4px 12px; border-radius: 12px; font-size: 13px; }
    .chat-container { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; max-height: 500px; overflow-y: auto; }
    .chat-msg { padding: 10px 14px; border-radius: 12px; max-width: 80%; font-size: 14px; }
    .user-msg { align-self: flex-end; background: #e3f2fd; color: #0d47a1; }
    .assistant-msg { align-self: flex-start; background: #f5f5f5; color: #212121; }
    .msg-role { font-size: 11px; font-weight: 500; color: #666; margin-bottom: 4px; }
    .msg-content { white-space: pre-wrap; word-break: break-word; }
    .msg-time { font-size: 11px; color: #999; margin-top: 4px; }
    h4 { margin: 12px 0 8px; font-size: 14px; }
    .tool-calls { display: flex; flex-direction: column; gap: 8px; }
    .tool-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 14px; }
    .tool-card.tool-error { border-color: #ef9a9a; background: #fff5f5; }
    .tool-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .tool-duration { font-size: 12px; color: #666; }
    .tool-error-icon { font-size: 16px; width: 16px; height: 16px; color: #c62828; }
    .tool-result { font-size: 12px; color: #555; white-space: pre-wrap; word-break: break-word; max-height: 100px; overflow-y: auto; }
  `],
})
export class SlackConversationsComponent implements OnInit, OnDestroy {
  private conversationService = inject(SlackConversationService);
  private clientService = inject(ClientService);
  private snackBar = inject(MatSnackBar);
  private destroy$ = new Subject<void>();

  conversations = signal<SlackConversationSummary[]>([]);
  total = signal(0);
  clients = signal<Client[]>([]);
  expandedId = signal<string | null>(null);
  detail = signal<SlackConversationDetail | null>(null);
  loadingDetail = signal(false);

  clientFilter = '';
  startDate = '';
  endDate = '';
  pageSize = 50;
  pageIndex = 0;

  columns = ['operator', 'client', 'channel', 'messages', 'tokens', 'started', 'updated'];

  ngOnInit(): void {
    this.load();
    this.clientService.getClients()
      .pipe(takeUntil(this.destroy$), catchError(() => EMPTY))
      .subscribe(clients => this.clients.set(clients));
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  load(): void {
    this.conversationService
      .getConversations(this.buildFilters())
      .pipe(
        catchError(() => {
          this.snackBar.open('Failed to load conversations.', 'Dismiss', { duration: 5000 });
          return EMPTY;
        }),
      )
      .subscribe((res) => {
        this.conversations.set(res.items);
        this.total.set(res.total);
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

  toggleExpand(id: string): void {
    if (this.expandedId() === id) {
      this.expandedId.set(null);
      this.detail.set(null);
      return;
    }
    this.expandedId.set(id);
    this.detail.set(null);
    this.loadingDetail.set(true);

    this.conversationService
      .getConversation(id)
      .pipe(
        catchError(() => {
          this.snackBar.open('Failed to load conversation detail.', 'Dismiss', { duration: 5000 });
          this.loadingDetail.set(false);
          return EMPTY;
        }),
      )
      .subscribe((d) => {
        this.detail.set(d);
        this.loadingDetail.set(false);
      });
  }

  formatTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private buildFilters(): Record<string, string | number> {
    return {
      ...(this.clientFilter && { clientId: this.clientFilter }),
      ...(this.startDate && { startDate: new Date(this.startDate).toISOString() }),
      ...(this.endDate && { endDate: new Date(this.endDate).toISOString() }),
      limit: this.pageSize,
      offset: this.pageIndex * this.pageSize,
    };
  }
}
