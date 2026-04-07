import { Component, inject, OnInit, signal, OnDestroy, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatSnackBarModule, MatSnackBar } from '@angular/material/snack-bar';
import { Subject, EMPTY } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import {
  SlackConversationService,
  SlackConversationSummary,
  SlackConversationDetail,
} from '../../core/services/slack-conversation.service';
import { ClientService, Client } from '../../core/services/client.service';
import { BroncoButtonComponent, SelectComponent, PaginatorComponent, type PaginatorPageEvent } from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatSnackBarModule,
    BroncoButtonComponent,
    SelectComponent,
    PaginatorComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1 class="page-title">Slack Conversations</h1>
        <app-bronco-button variant="secondary" (click)="load()">
          Refresh
        </app-bronco-button>
      </div>

      <!-- Filters -->
      <div class="filter-card">
        <div class="filter-row">
          <app-select
            [value]="clientFilter"
            [options]="clientOptions()"
            [placeholder]="''"
            (valueChange)="clientFilter = $event; resetAndLoad()">
          </app-select>
          <div class="filter-field">
            <label class="filter-label">Start Date</label>
            <input class="text-input" type="date" [(ngModel)]="startDate" (change)="resetAndLoad()" />
          </div>
          <div class="filter-field">
            <label class="filter-label">End Date</label>
            <input class="text-input" type="date" [(ngModel)]="endDate" (change)="resetAndLoad()" />
          </div>
        </div>
      </div>

      <!-- Table -->
      <div class="table-card">
        @if (conversations().length === 0) {
          <div class="table-empty">No conversations found.</div>
        } @else {
          <table class="conv-table">
            <thead>
              <tr>
                <th>Operator</th>
                <th>Client</th>
                <th>Channel</th>
                <th>Messages</th>
                <th>Tokens</th>
                <th>Started</th>
                <th>Last Activity</th>
              </tr>
            </thead>
            <tbody>
              @for (row of conversations(); track row.id) {
                <tr class="conv-row"
                    tabindex="0"
                    role="button"
                    [attr.aria-expanded]="expandedId() === row.id"
                    (click)="toggleExpand(row.id)"
                    (keydown.enter)="toggleExpand(row.id)"
                    (keydown.space)="$event.preventDefault(); toggleExpand(row.id)">
                  <td>{{ row.operator.name }}</td>
                  <td>{{ row.client?.name ?? '—' }}</td>
                  <td><code>{{ row.channelId }}</code></td>
                  <td>{{ row.messageCount }}</td>
                  <td>
                    @if (row.totalInputTokens || row.totalOutputTokens) {
                      {{ (row.totalInputTokens ?? 0) + (row.totalOutputTokens ?? 0) | number }}
                    } @else {
                      —
                    }
                  </td>
                  <td>{{ formatTime(row.createdAt) }}</td>
                  <td>{{ formatTime(row.updatedAt) }}</td>
                </tr>
                @if (expandedId() === row.id) {
                  <tr class="detail-row-visible">
                    <td colspan="7">
                      <div class="detail-panel">
                        @if (loadingDetail()) {
                          <div class="loading-state">Loading conversation details...</div>
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
                                      <span class="tool-error-icon">✕</span>
                                    }
                                  </div>
                                  <div class="tool-result">{{ tc.resultPreview }}</div>
                                </div>
                              }
                            </div>
                          }
                        }
                      </div>
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        }

        <app-paginator
          [length]="total()"
          [pageSize]="pageSize"
          [pageIndex]="pageIndex"
          [pageSizeOptions]="[25, 50, 100]"
          (page)="onPage($event)" />
      </div>
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }

    .filter-card {
      background: var(--bg-card); border-radius: var(--radius-lg); padding: 16px;
      box-shadow: var(--shadow-card); margin-bottom: 16px;
    }
    .filter-row { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end; }
    .filter-row app-select { min-width: 180px; }
    .filter-field { display: flex; flex-direction: column; gap: 4px; }
    .filter-label { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); }
    .text-input {
      background: var(--bg-card); border: 1px solid var(--border-medium);
      border-radius: var(--radius-md); padding: 8px 12px; font-family: var(--font-primary);
      font-size: 14px; color: var(--text-primary); outline: none;
    }
    .text-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--focus-ring); }

    .table-card {
      background: var(--bg-card); border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card); overflow: hidden;
    }
    .table-empty {
      padding: 48px 24px; text-align: center;
      font-family: var(--font-primary); font-size: 14px; color: var(--text-tertiary);
    }
    .conv-table { width: 100%; border-collapse: collapse; }
    .conv-table thead th {
      text-align: left; padding: 10px 16px; font-family: var(--font-primary);
      font-size: 12px; font-weight: 500; color: var(--text-tertiary);
      border-bottom: 1px solid var(--border-light); user-select: none;
    }
    .conv-table tbody td {
      padding: 12px 16px; font-family: var(--font-primary); font-size: 14px;
      color: var(--text-secondary); border-bottom: 1px solid var(--border-light);
    }
    code {
      font-size: 12px; background: var(--bg-muted); padding: 2px 6px;
      border-radius: var(--radius-sm);
    }
    .conv-row { cursor: pointer; transition: background 120ms ease; }
    .conv-row:hover { background: var(--bg-hover); }

    .detail-row-visible td {
      padding: 0 !important; border-bottom: 1px solid var(--border-light);
    }
    .detail-panel {
      padding: 16px 24px; background: var(--bg-page);
      border-bottom: 1px solid var(--border-light);
    }
    .loading-state {
      font-family: var(--font-primary); font-size: 13px; color: var(--accent); padding: 8px 0;
    }
    .cost-summary { display: flex; gap: 12px; margin-bottom: 16px; }
    .cost-chip {
      background: var(--color-info-subtle); color: var(--accent);
      padding: 4px 12px; border-radius: var(--radius-pill);
      font-family: var(--font-primary); font-size: 13px;
    }
    .chat-container {
      display: flex; flex-direction: column; gap: 8px;
      margin-bottom: 16px; max-height: 500px; overflow-y: auto;
    }
    .chat-msg {
      padding: 10px 14px; border-radius: var(--radius-lg);
      max-width: 80%; font-family: var(--font-primary); font-size: 14px;
    }
    .user-msg {
      align-self: flex-end; background: var(--color-info-subtle); color: var(--accent);
    }
    .assistant-msg {
      align-self: flex-start; background: var(--bg-muted); color: var(--text-primary);
    }
    .msg-role {
      font-family: var(--font-primary); font-size: 11px; font-weight: 500;
      color: var(--text-tertiary); margin-bottom: 4px;
    }
    .msg-content { white-space: pre-wrap; word-break: break-word; }
    .msg-time {
      font-family: var(--font-primary); font-size: 11px;
      color: var(--text-tertiary); margin-top: 4px;
    }
    h4 {
      margin: 12px 0 8px; font-family: var(--font-primary); font-size: 14px;
      color: var(--text-primary);
    }
    .tool-calls { display: flex; flex-direction: column; gap: 8px; }
    .tool-card {
      background: var(--bg-card); border: 1px solid var(--border-light);
      border-radius: var(--radius-md); padding: 10px 14px;
    }
    .tool-card.tool-error {
      border-color: rgba(255, 59, 48, 0.3); background: rgba(255, 59, 48, 0.04);
    }
    .tool-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .tool-duration { font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary); }
    .tool-error-icon { font-size: 14px; color: var(--color-error); }
    .tool-result {
      font-family: var(--font-primary); font-size: 12px; color: var(--text-tertiary);
      white-space: pre-wrap; word-break: break-word; max-height: 100px; overflow-y: auto;
    }
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

  clientOptions = computed(() => [
    { value: '', label: 'All Clients' },
    ...this.clients().map(c => ({ value: c.id, label: c.name })),
  ]);

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

  onPage(event: PaginatorPageEvent): void {
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
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
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
