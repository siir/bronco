import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { TicketService, type Ticket, type TicketStats } from '../../core/services/ticket.service';

@Component({
  standalone: true,
  imports: [RouterLink, DatePipe, MatCardModule, MatIconModule, MatButtonModule, MatChipsModule],
  template: `
    <div class="dashboard-header">
      <h1>Dashboard</h1>
      <a mat-raised-button color="primary" routerLink="/tickets/new">
        <mat-icon>add</mat-icon> New Ticket
      </a>
    </div>

    @if (stats(); as s) {
      <div class="stat-cards">
        <mat-card class="stat-card">
          <mat-card-content>
            <div class="stat-value">{{ s.total }}</div>
            <div class="stat-label">Total Tickets</div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card stat-open">
          <mat-card-content>
            <div class="stat-value">{{ s.byStatus['OPEN'] ?? 0 }}</div>
            <div class="stat-label">Open</div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card stat-progress">
          <mat-card-content>
            <div class="stat-value">{{ s.byStatus['IN_PROGRESS'] ?? 0 }}</div>
            <div class="stat-label">In Progress</div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card stat-waiting">
          <mat-card-content>
            <div class="stat-value">{{ s.byStatus['WAITING'] ?? 0 }}</div>
            <div class="stat-label">Waiting</div>
          </mat-card-content>
        </mat-card>
        <mat-card class="stat-card stat-resolved">
          <mat-card-content>
            <div class="stat-value">{{ (s.byStatus['RESOLVED'] ?? 0) + (s.byStatus['CLOSED'] ?? 0) }}</div>
            <div class="stat-label">Resolved</div>
          </mat-card-content>
        </mat-card>
      </div>
    }

    <h2>Recent Tickets</h2>
    <div class="ticket-list">
      @for (ticket of recentTickets(); track ticket.id) {
        <mat-card class="ticket-card" [routerLink]="['/tickets', ticket.id]">
          <mat-card-content>
            <div class="ticket-row">
              <div class="ticket-info">
                <span class="ticket-subject">{{ ticket.subject }}</span>
                <span class="ticket-meta">{{ ticket.createdAt | date:'mediumDate' }}</span>
              </div>
              <div class="ticket-badges">
                <span class="priority priority-{{ ticket.priority.toLowerCase() }}">{{ ticket.priority }}</span>
                <span class="status status-{{ ticket.status.toLowerCase().replace('_', '-') }}">{{ ticket.status.replace('_', ' ') }}</span>
              </div>
            </div>
          </mat-card-content>
        </mat-card>
      } @empty {
        <p class="empty">No tickets yet. Create your first ticket to get started.</p>
      }
    </div>
  `,
  styles: [`
    .dashboard-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .stat-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card { text-align: center; cursor: default; }
    .stat-value { font-size: 32px; font-weight: 600; }
    .stat-label { font-size: 13px; color: #666; margin-top: 4px; }
    .stat-open .stat-value { color: #1565c0; }
    .stat-progress .stat-value { color: #e65100; }
    .stat-waiting .stat-value { color: #f9a825; }
    .stat-resolved .stat-value { color: #2e7d32; }
    .ticket-list { display: flex; flex-direction: column; gap: 8px; }
    .ticket-card { cursor: pointer; }
    .ticket-card:hover { background: #fafafa; }
    .ticket-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .ticket-info { display: flex; flex-direction: column; min-width: 0; }
    .ticket-subject { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ticket-meta { font-size: 12px; color: #999; }
    .ticket-badges { display: flex; gap: 8px; flex-shrink: 0; }
    .priority { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .priority-critical { background: #ffebee; color: #c62828; }
    .priority-high { background: #fff3e0; color: #e65100; }
    .priority-medium { background: #e3f2fd; color: #1565c0; }
    .priority-low { background: #e8f5e9; color: #2e7d32; }
    .status { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #f5f5f5; color: #666; }
    .status-open { background: #e3f2fd; color: #1565c0; }
    .status-in-progress { background: #fff3e0; color: #e65100; }
    .status-waiting { background: #fff8e1; color: #f9a825; }
    .status-resolved { background: #e8f5e9; color: #2e7d32; }
    .status-closed { background: #f5f5f5; color: #999; }
    .empty { color: #999; text-align: center; padding: 32px; }
    h2 { margin-top: 0; }
  `],
})
export class DashboardComponent implements OnInit {
  private ticketService = inject(TicketService);
  private destroyRef = inject(DestroyRef);

  stats = signal<TicketStats | null>(null);
  recentTickets = signal<Ticket[]>([]);

  ngOnInit(): void {
    this.ticketService.getStats().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(s => this.stats.set(s));
    this.ticketService.getTickets({ limit: 10 }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(res => this.recentTickets.set(res.tickets));
  }
}
