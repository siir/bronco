import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  AiUsageClientSummary,
  AiUsageLogEntry,
  AiUsageService,
} from '../../../../core/services/ai-usage.service';
import {
  BroncoButtonComponent,
  CardComponent,
  DataTableComponent,
  DataTableColumnComponent,
  PaginatorComponent,
  IconComponent,
  type PaginatorPageEvent,
} from '../../../../shared/components/index.js';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-client-ai-usage-tab',
  standalone: true,
  imports: [
    DatePipe,
    DecimalPipe,
    BroncoButtonComponent,
    CardComponent,
    DataTableComponent,
    DataTableColumnComponent,
    PaginatorComponent,
    IconComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">AI Usage</h3>
        <app-bronco-button variant="secondary" size="sm" (click)="loadAll()"><app-icon name="refresh" size="sm" /> Refresh</app-bronco-button>
      </div>

      @if (loading()) {
        <p class="status-text">Loading AI usage data…</p>
      } @else if (summary(); as s) {
        <div class="kpi-grid">
          @for (w of s.windows; track w.label) {
            <app-card padding="md" class="kpi-card">
              <div class="kpi-card-title">{{ w.label }}</div>
              <div class="kpi-row"><span class="kpi-label">Tokens In</span><span class="kpi-value">{{ w.inputTokens | number }}</span></div>
              <div class="kpi-row"><span class="kpi-label">Tokens Out</span><span class="kpi-value">{{ w.outputTokens | number }}</span></div>
              <div class="kpi-row"><span class="kpi-label">Base Cost</span><span class="kpi-value">\${{ w.baseCostUsd | number:'1.4-4' }}</span></div>
              <div class="kpi-row"><span class="kpi-label">Billed Cost</span><span class="kpi-value kpi-billed">\${{ w.billedCostUsd | number:'1.4-4' }}</span></div>
              <div class="kpi-row"><span class="kpi-label">Requests</span><span class="kpi-value">{{ w.requestCount | number }}</span></div>
            </app-card>
          }
        </div>
        <p class="markup-note">Billing markup: {{ s.billingMarkupPercent }}x</p>

        <h4 class="log-title">Prompt Log</h4>

        <app-data-table
          [data]="logs()"
          [trackBy]="trackById"
          [rowClickable]="false"
          emptyMessage="No AI usage logs for this client.">
          <app-data-column key="createdAt" header="Time" [sortable]="false" width="150px">
            <ng-template #cell let-l>{{ l.createdAt | date:'short' }}</ng-template>
          </app-data-column>
          <app-data-column key="taskType" header="Task" [sortable]="false">
            <ng-template #cell let-l>{{ l.taskType }}</ng-template>
          </app-data-column>
          <app-data-column key="model" header="Model" [sortable]="false">
            <ng-template #cell let-l>{{ l.model }}</ng-template>
          </app-data-column>
          <app-data-column key="provider" header="Provider" [sortable]="false" width="100px">
            <ng-template #cell let-l>{{ l.provider }}</ng-template>
          </app-data-column>
          <app-data-column key="inputTokens" header="In" [sortable]="false" width="80px">
            <ng-template #cell let-l>{{ l.inputTokens | number }}</ng-template>
          </app-data-column>
          <app-data-column key="outputTokens" header="Out" [sortable]="false" width="80px">
            <ng-template #cell let-l>{{ l.outputTokens | number }}</ng-template>
          </app-data-column>
          <app-data-column key="costUsd" header="Cost" [sortable]="false" width="100px">
            <ng-template #cell let-l>{{ l.costUsd != null ? '$' + (l.costUsd | number:'1.4-4') : '-' }}</ng-template>
          </app-data-column>
        </app-data-table>

        @if (logs().length > 0 || total() > 0) {
          <app-paginator
            [length]="total()"
            [pageSize]="pageSize"
            [pageIndex]="pageIndex()"
            [pageSizeOptions]="[pageSize]"
            (page)="onPageChange($event)" />
        }
      } @else {
        <p class="status-text">No AI usage data available. Click Refresh to load.</p>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .tab-section { padding: 16px 0; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .status-text {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 14px;
      padding: 32px 16px;
      text-align: center;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 12px;
    }

    @media (max-width: 1024px) {
      .kpi-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      .kpi-grid { grid-template-columns: 1fr; }
    }

    .kpi-card-title {
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 10px;
    }

    .kpi-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
    }

    .kpi-label {
      color: var(--text-secondary);
      font-family: var(--font-primary);
      font-size: 12px;
    }

    .kpi-value {
      font-weight: 500;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
      color: var(--text-primary);
    }

    .kpi-billed {
      color: var(--color-success);
      font-weight: 600;
    }

    .markup-note {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 12px;
      margin: 0 0 20px;
    }

    .log-title {
      margin: 16px 0 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
  `],
})
export class ClientAiUsageTabComponent implements OnInit {
  clientId = input.required<string>();

  private aiUsageService = inject(AiUsageService);
  private destroyRef = inject(DestroyRef);

  summary = signal<AiUsageClientSummary | null>(null);
  logs = signal<AiUsageLogEntry[]>([]);
  loading = signal(false);
  pageIndex = signal(0);
  total = signal(0);

  readonly pageSize = PAGE_SIZE;

  trackById = (l: AiUsageLogEntry): string => l.id;

  ngOnInit(): void {
    this.loadAll();
  }

  loadAll(): void {
    const cid = this.clientId();
    this.loading.set(true);
    this.aiUsageService.getClientSummary(cid)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (summary) => {
          this.summary.set(summary);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    this.loadLogs();
  }

  loadLogs(): void {
    const cid = this.clientId();
    const page = this.pageIndex();
    this.aiUsageService.getClientLogs(cid, { limit: this.pageSize, offset: page * this.pageSize })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.logs.set(res.logs);
          this.total.set(res.total);
        },
        error: () => this.logs.set([]),
      });
  }

  onPageChange(event: PaginatorPageEvent): void {
    this.pageIndex.set(event.pageIndex);
    this.loadLogs();
  }
}
