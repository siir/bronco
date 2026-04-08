import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TicketService, Ticket, ACTIVE_STATUS_FILTER } from '../../core/services/ticket.service.js';
import { TicketFilterPresetService, TicketFilterPreset } from '../../core/services/ticket-filter-preset.service.js';
import { TicketDialogComponent } from './ticket-dialog.component.js';
import { TicketQuickActionsDialogComponent } from './ticket-quick-actions-dialog.component.js';
import { TicketFilterDialogComponent, AdvancedFilters, EMPTY_ADVANCED_FILTERS } from './ticket-filter-dialog.component.js';
import {
  DataTableComponent,
  DataTableColumnComponent,
  BroncoButtonComponent,
  ToolbarComponent,
  SelectComponent,
  DialogComponent,
  StatusBadgeComponent,
  PriorityPillComponent,
  IconComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service.js';

interface StatusPill {
  label: string;
  value: string;
}

const STATUS_PILLS: StatusPill[] = [
  { label: 'All', value: '' },
  { label: 'Active', value: ACTIVE_STATUS_FILTER },
  { label: 'Open', value: 'OPEN' },
  { label: 'In Progress', value: 'IN_PROGRESS' },
  { label: 'Resolved', value: 'RESOLVED' },
];

@Component({
  standalone: true,
  imports: [
    RouterLink,
    DataTableComponent,
    DataTableColumnComponent,
    BroncoButtonComponent,
    ToolbarComponent,
    SelectComponent,
    DialogComponent,
    StatusBadgeComponent,
    PriorityPillComponent,
    TicketDialogComponent,
    TicketQuickActionsDialogComponent,
    TicketFilterDialogComponent,
    IconComponent,
  ],
  template: `
    <div class="ticket-list-page">
      <div class="page-header">
        <h1 class="page-title">Tickets</h1>
        <app-bronco-button variant="primary" (click)="showCreateDialog.set(true)">+ Create Ticket</app-bronco-button>
      </div>

      <!-- Quick filter pills -->
      <div class="filter-pills">
        @for (pill of statusPills; track pill.value) {
          <button
            class="filter-pill"
            [class.active]="statusFilter() === pill.value"
            (click)="onPillClick(pill.value)">
            {{ pill.label }}
          </button>
        }
      </div>

      <!-- Toolbar with preset management, category filter, and filter button -->
      <app-toolbar>
        <app-select
          [value]="selectedPresetId()"
          [options]="presetOptions()"
          placeholder="— No preset —"
          (valueChange)="onPresetSelected($event)" />
        <app-bronco-button variant="icon" size="sm" (click)="savePreset()" title="Save current filters as preset">
          <app-icon name="file" size="sm" />
        </app-bronco-button>

        @if (selectedPresetId()) {
          <app-bronco-button variant="icon" size="sm" (click)="deletePreset()" title="Delete preset">
            <app-icon name="delete" size="sm" />
          </app-bronco-button>
          <button
            class="default-toggle"
            [class.is-default]="isSelectedPresetDefault()"
            (click)="toggleDefault(!isSelectedPresetDefault())"
            title="Set as default preset">
            {{ isSelectedPresetDefault() ? 'Default' : 'Set default' }}
          </button>
        }

        <span class="toolbar-spacer"></span>

        <app-select
          [value]="categoryFilter()"
          [options]="categoryOptions"
          placeholder="All Categories"
          (valueChange)="onCategoryChange($event)" />

        <app-bronco-button variant="ghost" (click)="showFilterDialog.set(true)">
          <span class="filter-btn-content">
            <app-icon name="filter" size="sm" />
            Filter
            @if (hasAdvancedFilters()) {
              <span class="filter-dot"></span>
            }
          </span>
        </app-bronco-button>
      </app-toolbar>

      <app-data-table
        [data]="tickets()"
        [trackBy]="trackById"
        (rowClick)="navigateToTicket($event)"
        emptyMessage="No tickets match the current filters.">

        <app-data-column key="priority" header="Priority" width="90px" [sortable]="false">
          <ng-template #cell let-row>
            <app-priority-pill [priority]="row.priority" />
          </ng-template>
        </app-data-column>

        <app-data-column key="ticketNumber" header="#" width="70px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="ticket-number">{{ row.ticketNumber ? '#' + row.ticketNumber : '' }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="subject" header="Subject" [sortable]="false">
          <ng-template #cell let-row>
            <a [routerLink]="['/tickets', row.id]" class="subject-link" (click)="$event.stopPropagation()">{{ row.subject }}</a>
            @if (row.summary) {
              <div class="summary-preview" [title]="row.summary">{{ truncate(row.summary, 100) }}</div>
            }
          </ng-template>
        </app-data-column>

        <app-data-column key="client" header="Client" width="90px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="code-chip">{{ row.client?.shortCode }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="status" header="Status" width="110px" [sortable]="false">
          <ng-template #cell let-row>
            <app-status-badge [status]="row.status" />
          </ng-template>
        </app-data-column>

        <app-data-column key="analysisStatus" header="Analysis" width="110px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="analysis-chip" [class]="'analysis-' + (row.analysisStatus?.toLowerCase() ?? 'none')">
              {{ formatAnalysisStatus(row.analysisStatus) }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="category" header="Category" width="120px" [sortable]="false">
          <ng-template #cell let-row>
            {{ row.category ?? '-' }}
          </ng-template>
        </app-data-column>

        <app-data-column key="source" header="Source" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            {{ row.source }}
          </ng-template>
        </app-data-column>

        <app-data-column key="created" header="Created" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            {{ formatDate(row.createdAt) }}
          </ng-template>
        </app-data-column>

        <app-data-column key="actions" header="" width="48px" [sortable]="false">
          <ng-template #cell let-row>
            <app-bronco-button variant="icon" size="sm" (click)="openQuickActions(row); $event.stopPropagation()" title="Quick actions">
              <app-icon name="more-vertical" size="sm" />
            </app-bronco-button>
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    <!-- Create Ticket Dialog -->
    @if (showCreateDialog()) {
      <app-dialog [open]="true" title="Create Ticket" maxWidth="560px" (openChange)="showCreateDialog.set(false)">
        <app-ticket-dialog-content
          [clientId]="clientIdFilter()"
          (created)="onTicketCreated($event)"
          (cancelled)="showCreateDialog.set(false)" />
      </app-dialog>
    }

    <!-- Quick Actions Dialog -->
    @if (quickActionsTicket()) {
      <app-dialog [open]="true" [title]="'Quick Actions — ' + quickActionsTicket()!.subject" maxWidth="420px" (openChange)="quickActionsTicket.set(null)">
        <app-ticket-quick-actions-content
          [ticket]="quickActionsTicket()!"
          (saved)="onQuickActionsSaved($event)"
          (cancelled)="quickActionsTicket.set(null)" />
      </app-dialog>
    }

    <!-- Advanced Filter Dialog -->
    @if (showFilterDialog()) {
      <app-dialog [open]="true" title="Filter Tickets" maxWidth="520px" (openChange)="showFilterDialog.set(false)">
        <app-ticket-filter-dialog
          [currentFilters]="advancedFilters()"
          (apply)="applyAdvancedFilters($event); showFilterDialog.set(false)"
          (reset)="resetAdvancedFilters(); showFilterDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .ticket-list-page { }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .page-title {
      font-family: var(--font-primary);
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
    }

    /* Quick filter pills */
    .filter-pills {
      display: flex;
      gap: 8px;
      padding: 8px 0;
      flex-wrap: wrap;
    }

    .filter-pill {
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-pill);
      padding: 5px 14px;
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 400;
      cursor: pointer;
      font-family: var(--font-primary);
      transition: all 0.2s;
    }

    .filter-pill:hover {
      border-color: var(--text-tertiary);
    }

    .filter-pill.active {
      background: var(--text-primary);
      color: var(--text-on-accent);
      border-color: var(--text-primary);
      font-weight: 600;
    }

    /* Toolbar extras */
    .default-toggle {
      background: none;
      border: 1px solid var(--border-light);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      font-family: var(--font-primary);
      font-size: 12px;
      color: var(--text-tertiary);
      cursor: pointer;
      transition: all 120ms ease;
    }

    .default-toggle:hover {
      background: var(--bg-hover);
    }

    .default-toggle.is-default {
      background: var(--bg-active);
      color: var(--accent);
      border-color: var(--accent);
    }

    /* Filter button content */
    .filter-btn-content {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      position: relative;
    }

    .filter-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
      display: inline-block;
    }

    /* Table cell styles */
    .ticket-number {
      font-size: 12px;
      color: var(--text-tertiary);
      font-family: ui-monospace, monospace;
    }

    .subject-link {
      text-decoration: none;
      color: var(--accent);
      font-weight: 500;
      font-size: 13px;
    }

    .subject-link:hover {
      text-decoration: underline;
    }

    .summary-preview {
      font-size: 12px;
      color: var(--text-tertiary);
      margin-top: 2px;
      line-height: 1.3;
    }

    .code-chip {
      font-size: 12px;
      padding: 2px 8px;
      background: var(--bg-active);
      border-radius: var(--radius-sm);
      color: var(--accent);
      font-family: ui-monospace, monospace;
    }

    .analysis-chip {
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      white-space: nowrap;
    }

    .analysis-pending { background: var(--bg-muted); color: var(--text-tertiary); }
    .analysis-in_progress { background: var(--bg-active); color: var(--accent); }
    .analysis-completed { background: var(--color-success-subtle); color: var(--color-success); }
    .analysis-failed { background: var(--color-error-subtle); color: var(--color-error); }
    .analysis-skipped { background: var(--bg-muted); color: var(--text-tertiary); }
    .analysis-none { background: transparent; color: var(--text-tertiary); }
  `],
})
export class TicketListComponent implements OnInit {
  private ticketService = inject(TicketService);
  private presetService = inject(TicketFilterPresetService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);

  tickets = signal<Ticket[]>([]);
  presets = signal<TicketFilterPreset[]>([]);
  statusFilter = signal(ACTIVE_STATUS_FILTER);
  categoryFilter = signal('');
  clientIdFilter = signal('');
  selectedPresetId = signal('');
  advancedFilters = signal<AdvancedFilters>({ ...EMPTY_ADVANCED_FILTERS });

  showCreateDialog = signal(false);
  showFilterDialog = signal(false);
  quickActionsTicket = signal<Ticket | null>(null);

  statusPills = STATUS_PILLS;

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

  presetOptions = computed(() => {
    return [
      { value: '', label: '— No preset —' },
      ...this.presets().map(p => ({
        value: p.id,
        label: p.name + (p.isDefault ? ' \u2605' : ''),
      })),
    ];
  });

  hasAdvancedFilters = computed(() => {
    const f = this.advancedFilters();
    return !!(f.priority || f.clientId || f.source || f.analysisStatus || f.createdFrom || f.createdTo);
  });

  trackById = (row: Ticket) => row.id;

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
    const adv = this.advancedFilters();
    this.ticketService.getTickets({
      clientId: adv.clientId || this.clientIdFilter() || undefined,
      status: this.statusFilter() || undefined,
      category: adv.category || this.categoryFilter() || undefined,
      priority: adv.priority || undefined,
      source: adv.source || undefined,
      analysisStatus: adv.analysisStatus || undefined,
      createdFrom: adv.createdFrom || undefined,
      createdTo: adv.createdTo || undefined,
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

  onPillClick(value: string): void {
    this.statusFilter.set(value);
    this.selectedPresetId.set('');
    this.load();
  }

  onCategoryChange(value: string): void {
    this.categoryFilter.set(value);
    this.selectedPresetId.set('');
    this.load();
  }

  onPresetSelected(id: string): void {
    this.selectedPresetId.set(id);
    if (id) {
      const preset = this.presets().find(p => p.id === id);
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

  onTicketCreated(result: { id: string }): void {
    this.showCreateDialog.set(false);
    this.load();
    this.router.navigate(['/tickets', result.id]);
  }

  openQuickActions(ticket: Ticket): void {
    this.quickActionsTicket.set(ticket);
  }

  onQuickActionsSaved(_updated: Ticket): void {
    this.quickActionsTicket.set(null);
    this.load();
  }

  navigateToTicket(ticket: Ticket): void {
    this.router.navigate(['/tickets', ticket.id]);
  }

  applyAdvancedFilters(filters: AdvancedFilters): void {
    this.advancedFilters.set(filters);
    // If the dialog set a category, sync it to the category filter
    if (filters.category) {
      this.categoryFilter.set(filters.category);
    }
    this.selectedPresetId.set('');
    this.load();
  }

  resetAdvancedFilters(): void {
    this.advancedFilters.set({ ...EMPTY_ADVANCED_FILTERS });
    this.load();
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

  private applyPreset(preset: TicketFilterPreset): void {
    this.selectedPresetId.set(preset.id);
    this.statusFilter.set(preset.statusFilter ?? ACTIVE_STATUS_FILTER);
    this.categoryFilter.set(preset.categoryFilter ?? '');
    if (!this.clientIdFilter()) {
      this.clientIdFilter.set(preset.clientIdFilter ?? '');
    }
  }
}
