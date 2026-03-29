import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ClientService, Client } from '../../core/services/client.service';
import { TicketService, Ticket, ACTIVE_STATUS_FILTER } from '../../core/services/ticket.service';
import { SystemStatusService, SystemStatusResponse } from '../../core/services/system-status.service';

/** Short code used by the imap-worker as a sentinel client for emails with no matched client. */
const UNKNOWN_CLIENT_SHORT_CODE = '_unknown';

@Component({
  standalone: true,
  imports: [RouterLink, MatCardModule, MatIconModule, MatButtonModule],
  template: `
    <h1>Dashboard</h1>
    <div class="stats-grid">
      <mat-card>
        <mat-card-content>
          <div class="stat">
            <mat-icon class="stat-icon">business</mat-icon>
            <div>
              <div class="stat-value">{{ clients().length }}</div>
              <div class="stat-label">Clients</div>
            </div>
          </div>
        </mat-card-content>
        <mat-card-actions>
          <a mat-button routerLink="/clients">View All</a>
        </mat-card-actions>
      </mat-card>

      <mat-card>
        <mat-card-content>
          <div class="stat">
            <mat-icon class="stat-icon" style="color: #f57c00">confirmation_number</mat-icon>
            <div>
              <div class="stat-value">{{ openTickets() }}</div>
              <div class="stat-label">Open Tickets</div>
            </div>
          </div>
        </mat-card-content>
        <mat-card-actions>
          <a mat-button routerLink="/tickets">View All</a>
        </mat-card-actions>
      </mat-card>

      <mat-card>
        <mat-card-content>
          <div class="stat">
            <mat-icon class="stat-icon" style="color: #388e3c">storage</mat-icon>
            <div>
              <div class="stat-value">{{ totalSystems() }}</div>
              <div class="stat-label">Database Systems</div>
            </div>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card>
        <mat-card-content>
          <div class="stat">
            <mat-icon class="stat-icon" style="color: #d32f2f">priority_high</mat-icon>
            <div>
              <div class="stat-value">{{ criticalTickets() }}</div>
              <div class="stat-label">Critical Tickets</div>
            </div>
          </div>
        </mat-card-content>
      </mat-card>

      <!-- System Status Summary -->
      @if (statusData(); as status) {
        <mat-card [class]="'status-summary-card status-' + status.status.toLowerCase()">
          <mat-card-content>
            <div class="stat">
              <mat-icon class="stat-icon" [style.color]="statusColor(status.status)">{{ statusIcon(status.status) }}</mat-icon>
              <div>
                <div class="stat-value">{{ upCount() }}/{{ status.components.length + (status.mcpServers?.length ?? 0) + (status.llmProviders?.length ?? 0) }}</div>
                <div class="stat-label">Services {{ status.status === 'UP' ? 'OK' : status.status }}</div>
              </div>
            </div>
          </mat-card-content>
          <mat-card-actions>
            <a mat-button routerLink="/system-status">View Status</a>
          </mat-card-actions>
        </mat-card>
      }

      <!-- Unknown / unassigned client warning -->
      @if (unknownClientTickets() > 0) {
        <mat-card class="unknown-client-card">
          <mat-card-content>
            <div class="stat">
              <mat-icon class="stat-icon" style="color: #f57c00">person_off</mat-icon>
              <div>
                <div class="stat-value">{{ unknownClientTickets() }}</div>
                <div class="stat-label">Unassigned Client</div>
              </div>
            </div>
          </mat-card-content>
          <mat-card-actions>
            <a mat-button [routerLink]="['/tickets']" [queryParams]="{ clientId: unknownClientId() }">View Tickets</a>
          </mat-card-actions>
        </mat-card>
      }
    </div>

    <h2>Recent Tickets</h2>
    <div class="ticket-list">
      @for (ticket of recentTickets(); track ticket.id) {
        <mat-card class="ticket-card">
          <mat-card-content>
            <div class="ticket-row">
              <span class="ticket-priority priority-{{ ticket.priority.toLowerCase() }}">{{ ticket.priority }}</span>
              <a [routerLink]="['/tickets', ticket.id]" class="ticket-subject">{{ ticket.subject }}</a>
              <span class="ticket-client" [class.ticket-client-unknown]="ticket.client?.shortCode === UNKNOWN_CLIENT_SHORT_CODE">{{ ticket.client?.shortCode ?? '—' }}</span>
              <span class="ticket-status">{{ ticket.status }}</span>
            </div>
          </mat-card-content>
        </mat-card>
      } @empty {
        <p class="empty">No tickets yet.</p>
      }
    </div>
  `,
  styles: [`
    h1 { margin: 0 0 24px; }
    h2 { margin: 32px 0 16px; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 8px 0;
    }
    .stat-icon { font-size: 36px; width: 36px; height: 36px; color: #3f51b5; }
    .stat-value { font-size: 28px; font-weight: 500; }
    .stat-label { color: #666; font-size: 14px; }
    .ticket-list { display: flex; flex-direction: column; gap: 8px; }
    .ticket-card { cursor: pointer; }
    .ticket-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ticket-subject {
      flex: 1;
      text-decoration: none;
      color: #333;
      font-weight: 500;
    }
    .ticket-subject:hover { color: #3f51b5; }
    .ticket-priority {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .priority-critical { background: #ffebee; color: #c62828; }
    .priority-high { background: #fff3e0; color: #e65100; }
    .priority-medium { background: #e3f2fd; color: #1565c0; }
    .priority-low { background: #e8f5e9; color: #2e7d32; }
    .ticket-client {
      font-size: 12px;
      padding: 2px 8px;
      background: #e8eaf6;
      border-radius: 4px;
      color: #3f51b5;
    }
    .ticket-client-unknown {
      background: #fff3e0;
      color: #e65100;
    }
    .ticket-status {
      font-size: 12px;
      color: #666;
    }
    .empty { color: #999; padding: 16px; }
    .status-summary-card.status-up { border-left: 4px solid #4caf50; }
    .status-summary-card.status-degraded { border-left: 4px solid #ff9800; }
    .status-summary-card.status-down { border-left: 4px solid #f44336; }
    .unknown-client-card { border-left: 4px solid #f57c00; }
  `],
})
export class DashboardComponent implements OnInit {
  private clientService = inject(ClientService);
  private ticketService = inject(TicketService);
  private systemStatusService = inject(SystemStatusService);
  private destroyRef = inject(DestroyRef);

  clients = signal<Client[]>([]);
  recentTickets = signal<Ticket[]>([]);
  openTickets = signal(0);
  criticalTickets = signal(0);
  totalSystems = signal(0);
  statusData = signal<SystemStatusResponse | null>(null);
  upCount = signal(0);
  unknownClientId = signal('');
  unknownClientTickets = signal(0);
  readonly UNKNOWN_CLIENT_SHORT_CODE = UNKNOWN_CLIENT_SHORT_CODE;

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
      error: () => {},
    });
  }

  statusIcon(status: string): string {
    switch (status) {
      case 'UP': return 'check_circle';
      case 'DEGRADED': return 'warning';
      case 'DOWN': return 'error';
      default: return 'help';
    }
  }

  statusColor(status: string): string {
    switch (status) {
      case 'UP': return '#4caf50';
      case 'DEGRADED': return '#ff9800';
      case 'DOWN': return '#f44336';
      default: return '#9e9e9e';
    }
  }
}
