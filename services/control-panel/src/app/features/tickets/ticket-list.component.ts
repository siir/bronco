import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TicketService, Ticket, ACTIVE_STATUS_FILTER } from '../../core/services/ticket.service';
import { TicketFilterPresetService, TicketFilterPreset } from '../../core/services/ticket-filter-preset.service';
import { TicketDialogComponent } from './ticket-dialog.component';
import { TicketQuickActionsDialogComponent } from './ticket-quick-actions-dialog.component';

@Component({
  standalone: true,
  imports: [RouterLink, FormsModule, MatCardModule, MatTableModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatSelectModule, MatDialogModule, MatTooltipModule, MatSlideToggleModule],
  template: `
    <div class="page-header">
      <h1>Tickets</h1>
      <button mat-raised-button color="primary" (click)="createTicket()">
        <mat-icon>add</mat-icon> Create Ticket
      </button>
    </div>

    <div class="filters">
      <mat-form-field>
        <mat-label>Preset</mat-label>
        <mat-select [(ngModel)]="selectedPresetId" (ngModelChange)="onPresetSelected()">
          <mat-option value="">— No preset —</mat-option>
          @for (p of presets(); track p.id) {
            <mat-option [value]="p.id">{{ p.name }}{{ p.isDefault ? ' ★' : '' }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <button mat-icon-button matTooltip="Save current filters as preset" (click)="savePreset()">
        <mat-icon>save</mat-icon>
      </button>
      @if (selectedPresetId) {
        <button mat-icon-button matTooltip="Delete preset" (click)="deletePreset()">
          <mat-icon>delete</mat-icon>
        </button>
        <mat-slide-toggle
          [checked]="isSelectedPresetDefault()"
          (change)="toggleDefault($event.checked)"
          matTooltip="Set as default preset">
          Default
        </mat-slide-toggle>
      }

      <mat-form-field>
        <mat-label>Status</mat-label>
        <mat-select [(ngModel)]="statusFilter" (ngModelChange)="onFilterChange()">
          <mat-option [value]="activeFilter">Active</mat-option>
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
        <mat-select [(ngModel)]="categoryFilter" (ngModelChange)="onFilterChange()">
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

    <mat-card>
      <table mat-table [dataSource]="tickets()" class="full-width">
        <ng-container matColumnDef="priority">
          <th mat-header-cell *matHeaderCellDef>Priority</th>
          <td mat-cell *matCellDef="let t">
            <span class="priority priority-{{ t.priority.toLowerCase() }}">{{ t.priority }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="ticketNumber">
          <th mat-header-cell *matHeaderCellDef>#</th>
          <td mat-cell *matCellDef="let t">
            <span class="ticket-number">{{ t.ticketNumber ? '#' + t.ticketNumber : '' }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="subject">
          <th mat-header-cell *matHeaderCellDef>Subject</th>
          <td mat-cell *matCellDef="let t">
            <a [routerLink]="['/tickets', t.id]" class="link">{{ t.subject }}</a>
            @if (t.summary) {
              <div class="summary-preview" [title]="t.summary">{{ truncate(t.summary, 100) }}</div>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="client">
          <th mat-header-cell *matHeaderCellDef>Client</th>
          <td mat-cell *matCellDef="let t">
            <span class="code-chip">{{ t.client?.shortCode }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let t">
            <span class="status-chip status-{{ t.status.toLowerCase() }}">{{ formatStatus(t.status) }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="category">
          <th mat-header-cell *matHeaderCellDef>Category</th>
          <td mat-cell *matCellDef="let t">{{ t.category ?? '-' }}</td>
        </ng-container>

        <ng-container matColumnDef="analysisStatus">
          <th mat-header-cell *matHeaderCellDef>Analysis</th>
          <td mat-cell *matCellDef="let t">
            <span class="analysis-chip analysis-{{ t.analysisStatus?.toLowerCase() }}">
              @if (t.analysisStatus === 'IN_PROGRESS') {
                <mat-icon class="spin-icon">sync</mat-icon>
              }
              {{ formatAnalysisStatus(t.analysisStatus) }}
            </span>
          </td>
        </ng-container>

        <ng-container matColumnDef="source">
          <th mat-header-cell *matHeaderCellDef>Source</th>
          <td mat-cell *matCellDef="let t">{{ t.source }}</td>
        </ng-container>

        <ng-container matColumnDef="created">
          <th mat-header-cell *matHeaderCellDef>Created</th>
          <td mat-cell *matCellDef="let t">{{ formatDate(t.createdAt) }}</td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let t">
            <button mat-icon-button matTooltip="Quick actions" aria-label="Quick actions" (click)="openQuickActions(t); $event.stopPropagation()">
              <mat-icon>more_vert</mat-icon>
            </button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns;"></tr>
      </table>
    </mat-card>

    @if (tickets().length === 0) {
      <p class="empty">No tickets match the current filters.</p>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .filters { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
    .full-width { width: 100%; }
    .link { text-decoration: none; color: #3f51b5; font-weight: 500; }
    .link:hover { text-decoration: underline; }
    .summary-preview { font-size: 12px; color: #666; margin-top: 2px; line-height: 1.3; }
    .ticket-number { font-size: 12px; color: #666; font-family: monospace; }
    .code-chip { font-size: 12px; padding: 2px 8px; background: #e8eaf6; border-radius: 4px; color: #3f51b5; font-family: monospace; }
    .priority { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .priority-critical { background: #ffebee; color: #c62828; }
    .priority-high { background: #fff3e0; color: #e65100; }
    .priority-medium { background: #e3f2fd; color: #1565c0; }
    .priority-low { background: #e8f5e9; color: #2e7d32; }
    .empty { color: #999; padding: 16px; text-align: center; }
    .status-chip { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .status-open { background: #e3f2fd; color: #1565c0; }
    .status-in_progress { background: #fff3e0; color: #e65100; }
    .status-waiting { background: #f3e5f5; color: #6a1b9a; }
    .status-resolved { background: #e8f5e9; color: #2e7d32; }
    .status-closed { background: #f5f5f5; color: #666; }
    .analysis-chip { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
    .analysis-pending { background: #f5f5f5; color: #666; }
    .analysis-in_progress { background: #e3f2fd; color: #1565c0; }
    .analysis-completed { background: #e8f5e9; color: #2e7d32; }
    .analysis-failed { background: #ffebee; color: #c62828; }
    .analysis-skipped { background: #f5f5f5; color: #999; }
    .spin-icon { font-size: 14px; width: 14px; height: 14px; animation: spin 1.5s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  `],
})
export class TicketListComponent implements OnInit {
  private ticketService = inject(TicketService);
  private presetService = inject(TicketFilterPresetService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  tickets = signal<Ticket[]>([]);
  presets = signal<TicketFilterPreset[]>([]);
  activeFilter = ACTIVE_STATUS_FILTER;
  statusFilter = ACTIVE_STATUS_FILTER;
  categoryFilter = '';
  clientIdFilter = '';
  selectedPresetId = '';
  columns = ['priority', 'ticketNumber', 'subject', 'client', 'status', 'analysisStatus', 'category', 'source', 'created', 'actions'];

  ngOnInit(): void {
    this.clientIdFilter = this.route.snapshot.queryParams['clientId'] ?? '';
    this.loadPresets({
      next: () => {
        const defaultPreset = this.presets().find(p => p.isDefault);
        if (defaultPreset) {
          this.applyPreset(defaultPreset);
        }
        this.load();
      },
      error: () => this.load(),
    });
  }

  load(): void {
    this.ticketService.getTickets({
      clientId: this.clientIdFilter || undefined,
      status: this.statusFilter || undefined,
      category: this.categoryFilter || undefined,
      limit: 100,
    }).subscribe(tickets => this.tickets.set(tickets));
  }

  loadPresets(handlers?: { next?: () => void; error?: () => void }): void {
    this.presetService.getPresets().subscribe({
      next: presets => {
        this.presets.set(presets);
        handlers?.next?.();
      },
      error: () => handlers?.error?.(),
    });
  }

  onPresetSelected(): void {
    if (this.selectedPresetId) {
      const preset = this.presets().find(p => p.id === this.selectedPresetId);
      if (preset) this.applyPreset(preset);
    }
    this.load();
  }

  onFilterChange(): void {
    this.selectedPresetId = '';
    this.load();
  }

  savePreset(): void {
    const selected = this.presets().find(p => p.id === this.selectedPresetId);
    if (selected) {
      // Update existing preset with current filters
      this.presetService.updatePreset(selected.id, {
        statusFilter: this.statusFilter || null,
        categoryFilter: this.categoryFilter || null,
        clientIdFilter: this.clientIdFilter || null,
      }).subscribe({
        next: () => {
          this.snackBar.open(`Preset "${selected.name}" updated`, 'OK', { duration: 2000 });
          this.loadPresets();
        },
        error: (err) => this.snackBar.open(err.error?.error ?? 'Failed to update preset', 'OK', { duration: 3000 }),
      });
    } else {
      // Create new preset
      const name = window.prompt('Preset name:');
      if (!name?.trim()) return;
      this.presetService.createPreset({
        name: name.trim(),
        statusFilter: this.statusFilter || null,
        categoryFilter: this.categoryFilter || null,
        clientIdFilter: this.clientIdFilter || null,
      }).subscribe({
        next: (preset) => {
          this.snackBar.open(`Preset "${preset.name}" created`, 'OK', { duration: 2000 });
          this.loadPresets({ next: () => { this.selectedPresetId = preset.id; } });
        },
        error: (err) => this.snackBar.open(err.error?.error ?? 'Failed to create preset', 'OK', { duration: 3000 }),
      });
    }
  }

  deletePreset(): void {
    const selected = this.presets().find(p => p.id === this.selectedPresetId);
    if (!selected) return;
    if (!confirm(`Delete preset "${selected.name}"?`)) return;
    this.presetService.deletePreset(selected.id).subscribe({
      next: () => {
        this.snackBar.open(`Preset "${selected.name}" deleted`, 'OK', { duration: 2000 });
        this.selectedPresetId = '';
        this.loadPresets();
      },
      error: (err) => this.snackBar.open(err.error?.error ?? 'Failed to delete preset', 'OK', { duration: 3000 }),
    });
  }

  toggleDefault(checked: boolean): void {
    const selected = this.presets().find(p => p.id === this.selectedPresetId);
    if (!selected) return;
    this.presetService.updatePreset(selected.id, { isDefault: checked }).subscribe({
      next: () => {
        this.snackBar.open(checked ? `"${selected.name}" set as default` : 'Default cleared', 'OK', { duration: 2000 });
        this.loadPresets();
      },
      error: (err) => this.snackBar.open(err.error?.error ?? 'Failed to update preset', 'OK', { duration: 3000 }),
    });
  }

  isSelectedPresetDefault(): boolean {
    const selected = this.presets().find(p => p.id === this.selectedPresetId);
    return selected?.isDefault ?? false;
  }

  createTicket(): void {
    const ref = this.dialog.open(TicketDialogComponent, {
      width: '600px',
      data: { clientId: this.clientIdFilter || undefined },
    });
    ref.afterClosed().subscribe(result => {
      if (result) {
        this.load();
        this.router.navigate(['/tickets', result.id]);
      }
    });
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString();
  }

  openQuickActions(ticket: Ticket): void {
    const ref = this.dialog.open(TicketQuickActionsDialogComponent, {
      width: '420px',
      data: { ticket },
    });
    ref.afterClosed().subscribe(result => {
      if (result) this.load();
    });
  }

  formatStatus(status: string): string {
    const labels: Record<string, string> = {
      OPEN: 'Open',
      IN_PROGRESS: 'In Progress',
      WAITING: 'Waiting',
      RESOLVED: 'Resolved',
      CLOSED: 'Closed',
    };
    return labels[status] ?? status;
  }

  formatAnalysisStatus(status: string | undefined): string {
    const labels: Record<string, string> = {
      PENDING: 'Pending',
      IN_PROGRESS: 'Analyzing',
      COMPLETED: 'Completed',
      FAILED: 'Failed',
      SKIPPED: 'Skipped',
    };
    return labels[status ?? ''] ?? status ?? '-';
  }

  truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
  }

  private applyPreset(preset: TicketFilterPreset): void {
    this.selectedPresetId = preset.id;
    this.statusFilter = preset.statusFilter ?? this.activeFilter;
    this.categoryFilter = preset.categoryFilter ?? '';
    if (!this.clientIdFilter) {
      this.clientIdFilter = preset.clientIdFilter ?? '';
    }
  }
}
