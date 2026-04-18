import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { ClientService, Client } from '../../core/services/client.service.js';
import { ClientDialogComponent } from './client-dialog.component.js';
import { DetailPanelService } from '../../core/services/detail-panel.service.js';
import { DataTableComponent, DataTableColumnComponent, BroncoButtonComponent, DialogComponent } from '../../shared/components/index.js';

@Component({
  standalone: true,
  imports: [DataTableComponent, DataTableColumnComponent, BroncoButtonComponent, DialogComponent, ClientDialogComponent],
  template: `
    <div class="client-list-page">
      <div class="page-header">
        <h1 class="page-title">Clients</h1>
        <app-bronco-button variant="primary" (click)="showClientDialog.set(true)">+ New Client</app-bronco-button>
      </div>

      <app-data-table
        [data]="clients()"
        [trackBy]="trackById"
        (rowClick)="onClientClick($event)"
        emptyMessage="No clients yet">

        <app-data-column key="name" header="Name" [sortable]="false" mobilePriority="primary">
          <ng-template #cell let-row>
            <span style="font-weight: 500; color: var(--text-primary);">{{ row.name }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="shortCode" header="Code" width="100px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            <span style="font-size: 12px; padding: 2px 8px; background: var(--bg-active); border-radius: var(--radius-sm); color: var(--accent); font-family: ui-monospace, monospace;">
              {{ row.shortCode }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="systems" header="Systems" width="90px" [sortable]="false" mobilePriority="hidden">
          <ng-template #cell let-row>
            {{ row._count?.systems ?? 0 }}
          </ng-template>
        </app-data-column>

        <app-data-column key="tickets" header="Tickets" width="90px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            {{ row._count?.tickets ?? 0 }}
          </ng-template>
        </app-data-column>

        <app-data-column key="status" header="Status" width="100px" [sortable]="false" mobilePriority="secondary">
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

    @if (showClientDialog()) {
      <app-dialog [open]="true" title="New Client" maxWidth="500px" (openChange)="showClientDialog.set(false)">
        <app-client-dialog-content
          (created)="onClientCreated()"
          (cancelled)="showClientDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .client-list-page { max-width: 1200px; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }
  `],
})
export class ClientListComponent implements OnInit {
  private clientService = inject(ClientService);
  private detailPanel = inject(DetailPanelService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  clients = signal<Client[]>([]);
  showClientDialog = signal(false);
  trackById = (item: Client) => item.id;

  ngOnInit(): void {
    this.load();
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(params => this.handleCreateQueryParam(params.get('create')));
  }

  private handleCreateQueryParam(create: string | null): void {
    if (!create) return;
    this.showClientDialog.set(true);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { create: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  load(): void {
    this.clientService.getClients().subscribe(clients => this.clients.set(clients));
  }

  onClientClick(client: Client): void {
    this.detailPanel.open('client', client.id);
  }

  onClientCreated(): void {
    this.showClientDialog.set(false);
    this.load();
  }
}
