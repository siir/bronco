import { Component, inject, OnInit, signal } from '@angular/core';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ClientService, Client } from '../../core/services/client.service.js';
import { ClientDialogComponent } from './client-dialog.component.js';
import { DetailPanelService } from '../../core/services/detail-panel.service.js';
import { DataTableComponent, DataTableColumnComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [MatDialogModule, DataTableComponent, DataTableColumnComponent, BroncoButtonComponent],
  template: `
    <div class="client-list-page">
      <div class="page-header">
        <h1 class="page-title">Clients</h1>
        <app-bronco-button variant="primary" (click)="createClient()">+ New Client</app-bronco-button>
      </div>

      <app-data-table
        [data]="clients()"
        [trackBy]="trackById"
        (rowClick)="onClientClick($event)"
        emptyMessage="No clients yet">

        <app-data-column key="name" header="Name" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-weight: 500; color: var(--text-primary);">{{ row.name }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="shortCode" header="Code" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-size: 12px; padding: 2px 8px; background: var(--bg-active); border-radius: var(--radius-sm); color: var(--accent); font-family: ui-monospace, monospace;">
              {{ row.shortCode }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="systems" header="Systems" width="90px" [sortable]="false">
          <ng-template #cell let-row>
            {{ row._count?.systems ?? 0 }}
          </ng-template>
        </app-data-column>

        <app-data-column key="tickets" header="Tickets" width="90px" [sortable]="false">
          <ng-template #cell let-row>
            {{ row._count?.tickets ?? 0 }}
          </ng-template>
        </app-data-column>

        <app-data-column key="status" header="Status" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            @if (row.isActive) {
              <span style="font-size: 12px; font-weight: 500; color: var(--color-success);">Active</span>
            } @else {
              <span style="font-size: 12px; color: var(--text-tertiary);">Inactive</span>
            }
          </ng-template>
        </app-data-column>

      </app-data-table>
    </div>
  `,
  styles: [`
    .client-list-page { max-width: 1200px; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }
  `],
})
export class ClientListComponent implements OnInit {
  private clientService = inject(ClientService);
  private dialog = inject(MatDialog);
  private detailPanel = inject(DetailPanelService);

  clients = signal<Client[]>([]);
  trackById = (item: Client) => item.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.clientService.getClients().subscribe(clients => this.clients.set(clients));
  }

  onClientClick(client: Client): void {
    this.detailPanel.open('client', client.id);
  }

  createClient(): void {
    const dialogRef = this.dialog.open(ClientDialogComponent, { width: '500px' });
    dialogRef.afterClosed().subscribe(result => {
      if (result) this.load();
    });
  }
}
