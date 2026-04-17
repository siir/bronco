import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Ticket, TicketService } from '../../../../core/services/ticket.service.js';
import {
  BroncoButtonComponent,
  CategoryChipComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
  PriorityPillComponent,
} from '../../../../shared/components/index.js';
import { TicketDialogComponent } from '../../../tickets/ticket-dialog.component.js';

type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

@Component({
  selector: 'app-client-tickets-tab',
  standalone: true,
  imports: [
    RouterLink,
    BroncoButtonComponent,
    CategoryChipComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    PriorityPillComponent,
    TicketDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Tickets</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openCreateDialog()">+ Create Ticket</app-bronco-button>
      </div>

      <app-data-table
        [data]="tickets()"
        [trackBy]="trackById"
        [rowClickable]="false"
        emptyMessage="No tickets for this client.">
        <app-data-column key="subject" header="Subject" [sortable]="false">
          <ng-template #cell let-t>
            <a class="link" [routerLink]="['/tickets', t.id]">{{ t.subject }}</a>
          </ng-template>
        </app-data-column>
        <app-data-column key="status" header="Status" [sortable]="false" width="120px">
          <ng-template #cell let-t>{{ t.status }}</ng-template>
        </app-data-column>
        <app-data-column key="priority" header="Priority" [sortable]="false" width="100px">
          <ng-template #cell let-t>
            <app-priority-pill [priority]="asPriority(t.priority)" />
          </ng-template>
        </app-data-column>
        <app-data-column key="category" header="Category" [sortable]="false" width="160px">
          <ng-template #cell let-t>
            @if (t.category) {
              <app-category-chip [category]="t.category" />
            } @else {
              <span class="muted">-</span>
            }
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    @if (showDialog()) {
      <app-dialog [open]="true" title="Create Ticket" maxWidth="560px" (openChange)="showDialog.set(false)">
        <app-ticket-dialog-content
          [clientId]="clientId()"
          (created)="onCreated()"
          (cancelled)="showDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    :host { display: block; }

    .tab-section { padding: 16px 0; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
    }
    .link:hover { text-decoration: underline; }

    .muted { color: var(--text-tertiary); }
  `],
})
export class ClientTicketsTabComponent implements OnInit {
  clientId = input.required<string>();

  private ticketService = inject(TicketService);
  private destroyRef = inject(DestroyRef);

  tickets = signal<Ticket[]>([]);
  showDialog = signal(false);

  trackById = (t: Ticket): string => t.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.ticketService.getTickets({ clientId: this.clientId(), limit: 20 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(t => this.tickets.set(t));
  }

  openCreateDialog(): void {
    this.showDialog.set(true);
  }

  onCreated(): void {
    this.showDialog.set(false);
    this.load();
  }

  asPriority(value: string): Priority {
    const upper = value.toUpperCase();
    if (upper === 'CRITICAL' || upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW') {
      return upper;
    }
    return 'LOW';
  }
}
