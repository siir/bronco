import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { TicketService, Ticket, ACTIVE_STATUS_FILTER } from '../../core/services/ticket.service';
import { TicketFilterPresetService, TicketFilterPreset } from '../../core/services/ticket-filter-preset.service';
import { DetailPanelService } from '../../core/services/detail-panel.service';
import { TicketDialogComponent } from './ticket-dialog.component';
import { TicketQuickActionsDialogComponent } from './ticket-quick-actions-dialog.component';
import {
  DataTableComponent,
  DataTableColumnComponent,
  StatusBadgeComponent,
  PriorityPillComponent,
  CategoryChipComponent,
  BroncoButtonComponent,
  ToolbarComponent,
  SelectComponent,
  ToggleSwitchComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [
    MatDialogModule,
    DataTableComponent,
    DataTableColumnComponent,
    StatusBadgeComponent,
    PriorityPillComponent,
    CategoryChipComponent,
    BroncoButtonComponent,
    ToolbarComponent,
    SelectComponent,
    ToggleSwitchComponent,
  ],
  template: `
    <div class="ticket-list-page">
      <div class="page-header">
        <h1 class="page-title">Tickets</h1>
        <app-bronco-button variant="primary" (click)="createTicket()">+ Create Ticket</app-bronco-button>
      </div>

      <app-toolbar>
        <app-select
          [value]="selectedPresetId()"
          [options]="presetOptions()"
          placeholder=""
          (valueChange)="onPresetSelected($event)" />

        @if (selectedPresetId()) {
          <app-bronco-button variant="ghost" size="sm" (click)="savePreset()">Save</app-bronco-button>
          <app-bronco-button variant="ghost" size="sm" (click)="deletePreset()">Delete</app-bronco-button>
          <app-toggle-switch
            [checked]="isSelectedPresetDefault()"
            (checkedChange)="toggleDefault($event)"
            label="Default" />
        } @else {
          <app-bronco-button variant="ghost" size="sm" (click)="savePreset()">Save as Preset</app-bronco-button>
        }

        <span class="toolbar-spacer"></span>

        <app-select
          [value]="statusFilter()"
          [options]="statusOptions"
          placeholder=""
          (valueChange)="onStatusChange($event)" />

        <app-select
          [value]="categoryFilter()"
          [options]="categoryOptions"
          placeholder=""
          (valueChange)="onCategoryChange($event)" />
      </app-toolbar>

      <app-data-table
        [data]="tickets()"
        [trackBy]="trackById"
        [rowClickable]="true"
        (rowClick)="onTicketClick($event)"
        emptyMessage="No tickets match the current filters">

        <app-data-column key="priority" header="Priority" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            <app-priority-pill [priority]="mapPriority(row.priority)" />
          </ng-template>
        </app-data-column>

        <app-data-column key="ticketNumber" header="#" width="70px" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-size: 12px; color: var(--text-tertiary); font-family: ui-monospace, monospace;">
              {{ row.ticketNumber ? '#' + row.ticketNumber : '' }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="subject" header="Subject" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-weight: 500; color: var(--text-primary);">{{ row.subject }}</span>
            @if (row.summary) {
              <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px; line-height: 1.3;">
                {{ truncate(row.summary, 100) }}
              </div>
            }
          </ng-template>
        </app-data-column>

        <app-data-column key="client" header="Client" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            @if (row.client?.shortCode) {
              <span style="font-size: 12px; padding: 2px 8px; background: var(--bg-active); border-radius: var(--radius-sm); color: var(--accent); font-family: ui-monospace, monospace;">
                {{ row.client.shortCode }}
              </span>
            }
          </ng-template>
        </app-data-column>

        <app-data-column key="status" header="Status" width="120px" [sortable]="false">
          <ng-template #cell let-row>
            <app-status-badge [status]="mapStatus(row.status)" />
          </ng-template>
        </app-data-column>

        <app-data-column key="analysisStatus" header="Analysis" width="110px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="analysis-chip" [class]="'analysis-' + (row.analysisStatus?.toLowerCase() ?? 'pending')">
              @if (row.analysisStatus === 'IN_PROGRESS') {
                <span class="spin-icon">&#x21BB;</span>
              }
              {{ formatAnalysisStatus(row.analysisStatus) }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="category" header="Category" width="130px" [sortable]="false">
          <ng-template #cell let-row>
            <app-category-chip [category]="row.category ?? 'GENERAL'" />
          </ng-template>
        </app-data-column>

        <app-data-column key="created" header="Created" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-size: 12px; color: var(--text-tertiary);">{{ formatDate(row.createdAt) }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="actions" header="" width="40px" [sortable]="false">
          <ng-template #cell let-row>
            <app-bronco-button variant="icon" size="sm" aria-label="Quick actions" (click)="openQuickActions(row); $event.stopPropagation()">
              &#x22EE;
            </app-bronco-button>
          </ng-template>
        </app-data-column>

      </app-data-table>
    </div>
  `,
  styles: [`
    .ticket-list-page {
      max-width: 1200px;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .page-title {
      font-family: var(--font-primary);
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0;
    }

    .toolbar-spacer {
      flex: 1 1 auto;
    }

    .analysis-chip {
      font-family: var(--font-primary);
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .analysis-pending { background: var(--bg-muted); color: var(--text-tertiary); }
    .analysis-in_progress { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .analysis-completed { background: rgba(52, 199, 89, 0.08); color: var(--color-success); }
    .analysis-failed { background: rgba(255, 59, 48, 0.08); color: var(--color-error); }
    .analysis-skipped { background: var(--bg-muted); color: var(--text-tertiary); }

    .spin-icon {
      display: inline-block;
      font-size: 12px;
      animation: spin 1.5s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `],
})
export class TicketListComponent implements OnInit {
  private ticketService = inject(TicketService);
  private presetService = inject(TicketFilterPresetService);
  private detailPanel = inject(DetailPanelService);
  private route = inject(ActivatedRoute);
  private dialog = inject(MatDialog);
  private toast = inject(ToastService);

  tickets = signal<Ticket[]>([]);
  presets = signal<TicketFilterPreset[]>([]);

  statusFilter = signal(ACTIVE_STATUS_FILTER);
  categoryFilter = signal('');
  clientIdFilter = signal('');
  selectedPresetId = signal('');

  trackById = (item: Ticket) => item.id;

  statusOptions = [
    { value: ACTIVE_STATUS_FILTER, label: 'Active' },
    { value: '', label: 'All' },
    { value: 'OPEN', label: 'Open' },
    { value: 'IN_PROGRESS', label: 'In Progress' },
    { value: 'WAITING', label: 'Waiting' },
    { value: 'RESOLVED', label: 'Resolved' },
    { value: 'CLOSED', label: 'Closed' },
  ];

  categoryOptions = [
    { value: '', label: 'All Categories' },
    { value: 'DATABASE_PERF', label: 'Database Perf' },
    { value: 'BUG_FIX', label: 'Bug Fix' },
    { value: 'FEATURE_REQUEST', label: 'Feature Request' },
    { value: 'SCHEMA_CHANGE', label: 'Schema Change' },
    { value: 'CODE_REVIEW', label: 'Code Review' },
    { value: 'ARCHITECTURE', label: 'Architecture' },
    { value: 'GENERAL', label: 'General' },
  ];

  presetOptions = computed(() =>
    [{ value: '', label: '— No preset —' }, ...this.presets().map(p => ({
      value: p.id,
      label: p.name + (p.isDefault ? ' ★' : ''),
    }))]
  );

  ngOnInit(): void {
    this.clientIdFilter.set(this.route.snapshot.queryParams['clientId'] ?? '');
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
      clientId: this.clientIdFilter() || undefined,
      status: this.statusFilter() || undefined,
      category: this.categoryFilter() || undefined,
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

  onTicketClick(ticket: Ticket): void {
    this.detailPanel.open('ticket', ticket.id);
  }

  onStatusChange(value: string): void {
    this.statusFilter.set(value);
    this.selectedPresetId.set('');
    this.load();
  }

  onCategoryChange(value: string): void {
    this.categoryFilter.set(value);
    this.selectedPresetId.set('');
    this.load();
  }

  onPresetSelected(presetId: string): void {
    this.selectedPresetId.set(presetId);
    if (presetId) {
      const preset = this.presets().find(p => p.id === presetId);
      if (preset) this.applyPreset(preset);
    }
    this.load();
  }

  savePreset(): void {
    const selected = this.presets().find(p => p.id === this.selectedPresetId());
    if (selected) {
      this.presetService.updatePreset(selected.id, {
        statusFilter: this.statusFilter() || null,
        categoryFilter: this.categoryFilter() || null,
        clientIdFilter: this.clientIdFilter() || null,
      }).subscribe({
        next: () => {
          this.toast.success(`Preset "${selected.name}" updated`);
          this.loadPresets();
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Failed to update preset'),
      });
    } else {
      const name = window.prompt('Preset name:');
      if (!name?.trim()) return;
      this.presetService.createPreset({
        name: name.trim(),
        statusFilter: this.statusFilter() || null,
        categoryFilter: this.categoryFilter() || null,
        clientIdFilter: this.clientIdFilter() || null,
      }).subscribe({
        next: (preset) => {
          this.toast.success(`Preset "${preset.name}" created`);
          this.loadPresets({ next: () => { this.selectedPresetId.set(preset.id); } });
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Failed to create preset'),
      });
    }
  }

  deletePreset(): void {
    const selected = this.presets().find(p => p.id === this.selectedPresetId());
    if (!selected) return;
    if (!confirm(`Delete preset "${selected.name}"?`)) return;
    this.presetService.deletePreset(selected.id).subscribe({
      next: () => {
        this.toast.success(`Preset "${selected.name}" deleted`);
        this.selectedPresetId.set('');
        this.loadPresets();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Failed to delete preset'),
    });
  }

  toggleDefault(checked: boolean): void {
    const selected = this.presets().find(p => p.id === this.selectedPresetId());
    if (!selected) return;
    this.presetService.updatePreset(selected.id, { isDefault: checked }).subscribe({
      next: () => {
        this.toast.success(checked ? `"${selected.name}" set as default` : 'Default cleared');
        this.loadPresets();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Failed to update preset'),
    });
  }

  isSelectedPresetDefault(): boolean {
    const selected = this.presets().find(p => p.id === this.selectedPresetId());
    return selected?.isDefault ?? false;
  }

  createTicket(): void {
    const ref = this.dialog.open(TicketDialogComponent, {
      width: '600px',
      data: { clientId: this.clientIdFilter() || undefined },
    });
    ref.afterClosed().subscribe(result => {
      if (result) {
        this.load();
        this.detailPanel.open('ticket', result.id);
      }
    });
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

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString();
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

  mapPriority(priority: string): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
    const valid = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    return valid.has(priority) ? priority as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' : 'MEDIUM';
  }

  mapStatus(status: string): 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed' {
    const map: Record<string, 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed'> = {
      OPEN: 'open',
      IN_PROGRESS: 'in_progress',
      WAITING: 'in_progress',
      ANALYZING: 'analyzing',
      RESOLVED: 'resolved',
      CLOSED: 'closed',
    };
    return map[status] ?? 'open';
  }

  private applyPreset(preset: TicketFilterPreset): void {
    this.selectedPresetId.set(preset.id);
    this.statusFilter.set(preset.statusFilter ?? ACTIVE_STATUS_FILTER);
    this.categoryFilter.set(preset.categoryFilter ?? '');
    if (!this.clientIdFilter()) {
      this.clientIdFilter.set(preset.clientIdFilter ?? '');
    }
  }
}
