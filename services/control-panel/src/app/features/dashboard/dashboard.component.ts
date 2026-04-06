import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ClientService, Client } from '../../core/services/client.service';
import { TicketService, Ticket, ACTIVE_STATUS_FILTER } from '../../core/services/ticket.service';
import { SystemStatusService, SystemStatusResponse } from '../../core/services/system-status.service';
import { DetailPanelService } from '../../core/services/detail-panel.service';
import {
  StatCardComponent,
  DataTableComponent,
  DataTableColumnComponent,
  StatusBadgeComponent,
  PriorityPillComponent,
  CategoryChipComponent,
} from '../../shared/components/index.js';

/** Short code used by the imap-worker as a sentinel client for emails with no matched client. */
const UNKNOWN_CLIENT_SHORT_CODE = '_unknown';

@Component({
  standalone: true,
  imports: [
    StatCardComponent,
    DataTableComponent,
    DataTableColumnComponent,
    StatusBadgeComponent,
    PriorityPillComponent,
    CategoryChipComponent,
  ],
  template: `
    <div class="dashboard">
      <div class="stats-row">
        <app-stat-card label="Open Tickets" [value]="openTickets() + ''" change="" changeType="neutral" />
        <app-stat-card label="Critical" [value]="criticalTickets() + ''" change="" [changeType]="criticalTickets() > 0 ? 'negative' : 'neutral'" />
        <app-stat-card label="Clients" [value]="clients().length + ''" change="" changeType="neutral" />
        <app-stat-card label="Database Systems" [value]="totalSystems() + ''" change="" changeType="neutral" />
        <app-stat-card
          label="Services"
          [value]="servicesValue()"
          [change]="servicesChange()"
          [changeType]="servicesChangeType()" />
        @if (unknownClientTickets() > 0) {
          <app-stat-card
            label="Unassigned Client"
            [value]="unknownClientTickets() + ''"
            change="Needs attention"
            changeType="negative" />
        }
      </div>

      <h2 class="section-title">Recent Tickets</h2>

      <app-data-table
        [data]="recentTickets()"
        [trackBy]="trackById"
        [sortColumn]="sortColumn()"
        [sortDirection]="sortDirection()"
        (sortChange)="onSortChange($event)"
        (rowClick)="onTicketClick($event)"
        emptyMessage="No tickets yet">

        <app-data-column key="subject" header="Subject" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-weight: 500; color: var(--text-primary);">{{ row.subject }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="status" header="Status" width="130px" [sortable]="false">
          <ng-template #cell let-row>
            <app-status-badge [status]="mapStatus(row.status)" />
          </ng-template>
        </app-data-column>

        <app-data-column key="priority" header="Priority" width="110px" [sortable]="false">
          <ng-template #cell let-row>
            <app-priority-pill [priority]="row.priority" />
          </ng-template>
        </app-data-column>

        <app-data-column key="category" header="Category" width="140px" [sortable]="false">
          <ng-template #cell let-row>
            <app-category-chip [category]="row.category ?? 'GENERAL'" />
          </ng-template>
        </app-data-column>

        <app-data-column key="client" header="Client" width="140px" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-size: 13px; color: var(--text-secondary);">
              @if (row.client?.shortCode) {
                <span style="color: var(--accent); font-weight: 600;">{{ row.client.shortCode }}</span>
              }
              {{ row.client?.name ?? '—' }}
            </span>
          </ng-template>
        </app-data-column>

      </app-data-table>
    </div>
  `,
  styles: [`
    .dashboard {
      max-width: 1200px;
    }
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .section-title {
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 12px;
    }
  `],
})
export class DashboardComponent implements OnInit {
  private clientService = inject(ClientService);
  private ticketService = inject(TicketService);
  private systemStatusService = inject(SystemStatusService);
  private destroyRef = inject(DestroyRef);
  private detailPanel = inject(DetailPanelService);

  clients = signal<Client[]>([]);
  recentTickets = signal<Ticket[]>([]);
  openTickets = signal(0);
  criticalTickets = signal(0);
  totalSystems = signal(0);
  statusData = signal<SystemStatusResponse | null>(null);
  upCount = signal(0);
  servicesError = signal(false);
  unknownClientId = signal('');
  unknownClientTickets = signal(0);

  sortColumn = signal('');
  sortDirection = signal<'asc' | 'desc'>('asc');

  servicesValue = computed(() => {
    const status = this.statusData();
    if (!status) return '\u2014';
    const total = status.components.length + (status.mcpServers?.length ?? 0) + (status.llmProviders?.length ?? 0);
    return this.upCount() + '/' + total;
  });

  servicesChange = computed(() => {
    if (this.servicesError()) return 'Unavailable';
    const status = this.statusData();
    if (!status) return 'Loading...';
    return status.status === 'UP' ? 'All healthy' : status.status;
  });

  servicesChangeType = computed(() => {
    if (this.servicesError()) return 'negative' as const;
    const status = this.statusData();
    if (!status) return 'neutral' as const;
    return status.status === 'UP' ? 'positive' as const : 'negative' as const;
  });

  trackById = (item: Ticket) => item.id;

  ngOnInit(): void {
    this.clientService.getClients().subscribe(clients => {
      this.clients.set(clients);
      this.totalSystems.set(clients.reduce((sum, c) => sum + (c._count?.systems ?? 0), 0));

      const unknownClient = clients.find(c => c.shortCode === UNKNOWN_CLIENT_SHORT_CODE);
      if (unknownClient) {
        this.unknownClientId.set(unknownClient.id);
        this.ticketService.getStats(unknownClient.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(stats => {
          const active = ACTIVE_STATUS_FILTER.split(',').reduce((sum, s) => sum + (stats.byStatus[s] ?? 0), 0);
          this.unknownClientTickets.set(active);
        });
      }
    });

    this.ticketService.getTickets({ status: ACTIVE_STATUS_FILTER, limit: 10 }).subscribe(tickets => {
      this.recentTickets.set(tickets);
    });

    this.ticketService.getStats().subscribe(stats => {
      this.openTickets.set(ACTIVE_STATUS_FILTER.split(',').reduce((sum, s) => sum + (stats.byStatus[s] ?? 0), 0));
      this.criticalTickets.set(stats.byPriority['CRITICAL'] ?? 0);
    });

    this.systemStatusService.getStatus().subscribe({
      next: (res) => {
        this.statusData.set(res);
        const mcpUp = res.mcpServers?.filter(s => s.status === 'UP').length ?? 0;
        const llmUp = res.llmProviders?.filter(l => l.status === 'UP').length ?? 0;
        this.upCount.set(res.components.filter(c => c.status === 'UP').length + mcpUp + llmUp);
      },
      error: () => {
        this.statusData.set(null);
        this.servicesError.set(true);
      },
    });
  }

  onTicketClick(ticket: Ticket): void {
    this.detailPanel.open('ticket', ticket.id, 'compact');
  }

  onSortChange(event: { column: string; direction: 'asc' | 'desc' }): void {
    this.sortColumn.set(event.column);
    this.sortDirection.set(event.direction);
  }

  /** Map API ticket status strings to StatusBadge values */
  mapStatus(status: string): 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed' {
    const map: Record<string, 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed'> = {
      OPEN: 'open',
      IN_PROGRESS: 'in_progress',
      ANALYZING: 'analyzing',
      RESOLVED: 'resolved',
      CLOSED: 'closed',
    };
    return map[status] ?? 'open';
  }
}
