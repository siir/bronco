import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatChipsModule } from '@angular/material/chips';
import { TicketService, type Ticket } from '../../core/services/ticket.service';

@Component({
  standalone: true,
  imports: [RouterLink, DatePipe, FormsModule, MatTableModule, MatButtonModule, MatIconModule, MatSelectModule, MatFormFieldModule, MatChipsModule],
  template: `
    <div class="page-header">
      <h1>Tickets</h1>
      <a mat-raised-button color="primary" routerLink="/tickets/new">
        <mat-icon>add</mat-icon> New Ticket
      </a>
    </div>

    <div class="filters">
      <mat-form-field>
        <mat-label>Status</mat-label>
        <mat-select [(ngModel)]="statusFilter" (ngModelChange)="loadTickets()">
          <mat-option value="">All</mat-option>
          <mat-option value="OPEN">Open</mat-option>
          <mat-option value="IN_PROGRESS">In Progress</mat-option>
          <mat-option value="WAITING">Waiting</mat-option>
          <mat-option value="RESOLVED">Resolved</mat-option>
          <mat-option value="CLOSED">Closed</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Category</mat-label>
        <mat-select [(ngModel)]="categoryFilter" (ngModelChange)="loadTickets()">
          <mat-option value="">All</mat-option>
          <mat-option value="DATABASE_PERF">Database Perf</mat-option>
          <mat-option value="BUG_FIX">Bug Fix</mat-option>
          <mat-option value="FEATURE_REQUEST">Feature Request</mat-option>
          <mat-option value="SCHEMA_CHANGE">Schema Change</mat-option>
          <mat-option value="CODE_REVIEW">Code Review</mat-option>
          <mat-option value="ARCHITECTURE">Architecture</mat-option>
          <mat-option value="GENERAL">General</mat-option>
        </mat-select>
      </mat-form-field>
    </div>

    <table mat-table [dataSource]="tickets()" class="full-width">
      <ng-container matColumnDef="priority">
        <th mat-header-cell *matHeaderCellDef>Priority</th>
        <td mat-cell *matCellDef="let t">
          <span class="priority priority-{{ t.priority.toLowerCase() }}">{{ t.priority }}</span>
        </td>
      </ng-container>
      <ng-container matColumnDef="subject">
        <th mat-header-cell *matHeaderCellDef>Subject</th>
        <td mat-cell *matCellDef="let t">
          <a [routerLink]="['/tickets', t.id]" class="link">@if (t.ticketNumber) { <span class="ticket-num">#{{ t.ticketNumber }}</span> }{{ t.subject }}</a>
        </td>
      </ng-container>
      <ng-container matColumnDef="status">
        <th mat-header-cell *matHeaderCellDef>Status</th>
        <td mat-cell *matCellDef="let t">
          <span class="status status-{{ t.status.toLowerCase().replace('_', '-') }}">{{ t.status.replace('_', ' ') }}</span>
        </td>
      </ng-container>
      <ng-container matColumnDef="category">
        <th mat-header-cell *matHeaderCellDef>Category</th>
        <td mat-cell *matCellDef="let t">{{ t.category ?? '-' }}</td>
      </ng-container>
      <ng-container matColumnDef="created">
        <th mat-header-cell *matHeaderCellDef>Created</th>
        <td mat-cell *matCellDef="let t">{{ t.createdAt | date:'mediumDate' }}</td>
      </ng-container>
      <tr mat-header-row *matHeaderRowDef="columns"></tr>
      <tr mat-row *matRowDef="let row; columns: columns;"></tr>
    </table>
    @if (tickets().length === 0) {
      <p class="empty">No tickets match the current filters.</p>
    }

    @if (total() > tickets().length) {
      <div class="load-more">
        <button mat-button (click)="loadMore()">Load more ({{ total() - tickets().length }} remaining)</button>
      </div>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .full-width { width: 100%; }
    .ticket-num { font-size: 12px; color: #666; font-family: monospace; margin-right: 4px; }
    .link { text-decoration: none; color: #1565c0; }
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
    .load-more { text-align: center; margin-top: 16px; }
  `],
})
export class TicketListComponent implements OnInit {
  private ticketService = inject(TicketService);
  private destroyRef = inject(DestroyRef);

  tickets = signal<Ticket[]>([]);
  total = signal(0);
  columns = ['priority', 'subject', 'status', 'category', 'created'];
  statusFilter = '';
  categoryFilter = '';

  ngOnInit(): void {
    this.loadTickets();
  }

  loadTickets(): void {
    this.ticketService.getTickets({
      status: this.statusFilter || undefined,
      category: this.categoryFilter || undefined,
      limit: 50,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(res => {
      this.tickets.set(res.tickets);
      this.total.set(res.total);
    });
  }

  loadMore(): void {
    this.ticketService.getTickets({
      status: this.statusFilter || undefined,
      category: this.categoryFilter || undefined,
      limit: 50,
      offset: this.tickets().length,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(res => {
      this.tickets.update(current => [...current, ...res.tickets]);
    });
  }
}
