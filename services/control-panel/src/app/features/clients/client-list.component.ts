import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { MatChipsModule } from '@angular/material/chips';
import { ClientService, Client } from '../../core/services/client.service';
import { ClientDialogComponent } from './client-dialog.component';

@Component({
  standalone: true,
  imports: [RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatDialogModule, MatTableModule, MatChipsModule],
  template: `
    <div class="page-header">
      <h1>Clients</h1>
      <button mat-raised-button color="primary" (click)="openDialog()">
        <mat-icon>add</mat-icon> New Client
      </button>
    </div>

    <mat-card>
      <table mat-table [dataSource]="clients()" class="full-width">
        <ng-container matColumnDef="name">
          <th mat-header-cell *matHeaderCellDef>Name</th>
          <td mat-cell *matCellDef="let client">
            <a [routerLink]="['/clients', client.id]" class="link">{{ client.name }}</a>
          </td>
        </ng-container>

        <ng-container matColumnDef="shortCode">
          <th mat-header-cell *matHeaderCellDef>Code</th>
          <td mat-cell *matCellDef="let client">
            <span class="code-chip">{{ client.shortCode }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="systems">
          <th mat-header-cell *matHeaderCellDef>Systems</th>
          <td mat-cell *matCellDef="let client">{{ client._count?.systems ?? 0 }}</td>
        </ng-container>

        <ng-container matColumnDef="tickets">
          <th mat-header-cell *matHeaderCellDef>Tickets</th>
          <td mat-cell *matCellDef="let client">{{ client._count?.tickets ?? 0 }}</td>
        </ng-container>

        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let client">
            <mat-chip [highlighted]="client.isActive" [class.inactive]="!client.isActive">
              {{ client.isActive ? 'Active' : 'Inactive' }}
            </mat-chip>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="displayedColumns"></tr>
        <tr mat-row *matRowDef="let row; columns: displayedColumns;"></tr>
      </table>
    </mat-card>
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .full-width { width: 100%; }
    .link { text-decoration: none; color: #3f51b5; font-weight: 500; }
    .link:hover { text-decoration: underline; }
    .code-chip {
      font-size: 12px; padding: 2px 8px; background: #e8eaf6; border-radius: 4px; color: #3f51b5;
      font-family: monospace;
    }
    .inactive { opacity: 0.5; }
  `],
})
export class ClientListComponent implements OnInit {
  private clientService = inject(ClientService);
  private dialog = inject(MatDialog);

  clients = signal<Client[]>([]);
  displayedColumns = ['name', 'shortCode', 'systems', 'tickets', 'status'];

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.clientService.getClients().subscribe(clients => this.clients.set(clients));
  }

  openDialog(): void {
    const dialogRef = this.dialog.open(ClientDialogComponent, { width: '500px' });
    dialogRef.afterClosed().subscribe(result => {
      if (result) this.load();
    });
  }
}
