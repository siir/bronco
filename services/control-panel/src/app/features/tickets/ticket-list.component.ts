import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TicketService, Ticket, ACTIVE_STATUS_FILTER } from '../../core/services/ticket.service.js';
import { ClientService, Client } from '../../core/services/client.service.js';
import { TicketFilterPresetService, TicketFilterPreset } from '../../core/services/ticket-filter-preset.service.js';
import { TicketDialogComponent } from './ticket-dialog.component.js';
import { TicketQuickActionsDialogComponent } from './ticket-quick-actions-dialog.component.js';
import { TicketFilterDialogComponent, AdvancedFilters, EMPTY_ADVANCED_FILTERS } from './ticket-filter-dialog.component.js';
import {
  DataTableComponent,
  DataTableColumnComponent,
  BroncoButtonComponent,
  ToolbarComponent,
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

const CATEGORY_LABELS: Record<string, string> = {
  DATABASE_PERF: 'Database Perf',
  BUG_FIX: 'Bug Fix',
  FEATURE_REQUEST: 'Feature Request',
  SCHEMA_CHANGE: 'Schema Change',
  CODE_REVIEW: 'Code Review',
  ARCHITECTURE: 'Architecture',
  GENERAL: 'General',
};

const PRIORITY_LABELS: Record<string, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: 'Manual',
  EMAIL: 'Email',
  AZURE_DEVOPS: 'Azure DevOps',
  AI_DETECTED: 'AI Detected',
  SCHEDULED: 'Scheduled',
};

const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'Analyzing',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
};

interface ActiveFilterChip {
  key: 'category' | 'priority' | 'clientId' | 'source' | 'analysisStatus' | 'dates';
  label: string;
}

@Component({
  standalone: true,
  imports: [
    RouterLink,
    DataTableComponent,
    DataTableColumnComponent,
    BroncoButtonComponent,
    ToolbarComponent,
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

      <!-- Toolbar with filter button -->
      <app-toolbar>
        <span class="toolbar-spacer"></span>
        <app-bronco-button variant="ghost" (click)="openFilterDialog()">
          <span class="filter-btn-content">
            <app-icon name="filter" size="sm" />
            Filter
            @if (activeFilterChips().length > 0 || selectedPresetId()) {
              <span class="filter-dot"></span>
            }
          </span>
        </app-bronco-button>
      </app-toolbar>

      <!-- Active filter chips -->
      @if (activeFilterChips().length > 0) {
        <div class="active-filter-chips">
          @for (chip of activeFilterChips(); track chip.key) {
            <button
              type="button"
              class="filter-chip"
              (click)="removeFilter(chip.key)"
              [title]="'Remove filter: ' + chip.label">
              <span class="filter-chip-label">{{ chip.label }}</span>
              <app-icon name="close" size="xs" />
            </button>
          }
          <button type="button" class="clear-all-chip" (click)="clearAllAdvancedFilters()">Clear all</button>
        </div>
      }

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
      <app-dialog [open]="true" title="Filter Tickets" maxWidth="520px" (openChange)="cancelFilterDialog()">
        <app-ticket-filter-dialog
          [currentFilters]="advancedFilters()"
          [presets]="presets()"
          [selectedPresetId]="selectedPresetId()"
          (apply)="applyAdvancedFilters($event)"
          (cancel)="cancelFilterDialog()"
          (close)="closeFilterDialog()"
          (presetSelected)="onPresetSelected($event)"
          (presetSaveRequested)="savePreset()"
          (presetDeleteRequested)="deletePreset()"
          (presetDefaultToggleRequested)="toggleDefault($event)" />
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
      background: var(--accent);
      color: var(--text-on-accent);
      border-color: var(--accent);
      font-weight: 600;
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

    /* Active filter chips */
    .active-filter-chips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding: 8px 0 4px;
    }

    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
      color: var(--accent);
      border-radius: var(--radius-pill);
      padding: 4px 10px;
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }

    .filter-chip:hover {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      border-color: var(--accent);
    }

    .filter-chip-label {
      line-height: 1;
    }

    .clear-all-chip {
      background: none;
      border: none;
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      padding: 4px 8px;
      transition: color 120ms ease;
    }

    .clear-all-chip:hover {
      color: var(--text-secondary);
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
  private clientService = inject(ClientService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);

  tickets = signal<Ticket[]>([]);
  presets = signal<TicketFilterPreset[]>([]);
  clients = signal<Client[]>([]);
  statusFilter = signal(ACTIVE_STATUS_FILTER);
  categoryFilter = signal('');
  clientIdFilter = signal('');
  selectedPresetId = signal('');
  advancedFilters = signal<AdvancedFilters>({ ...EMPTY_ADVANCED_FILTERS });

  showCreateDialog = signal(false);
  showFilterDialog = signal(false);
  quickActionsTicket = signal<Ticket | null>(null);

  /** Snapshot of the filter state taken when the filter dialog opens; used by Cancel to revert. */
  private filterSnapshot: {
    statusFilter: string;
    categoryFilter: string;
    clientIdFilter: string;
    selectedPresetId: string;
    advancedFilters: AdvancedFilters;
  } | null = null;

  statusPills = STATUS_PILLS;

  presetOptions = computed(() => {
    const options = this.presets().map(p => ({
      value: p.id,
      label: p.name + (p.isDefault ? ' \u2605' : ''),
    }));
    return [{ value: '', label: '— No preset —' }, ...options];
  });

  /**
   * Chips representing every filter currently applied via the filter dialog
   * (or via the standalone category signal, which the dialog syncs into).
   * Each chip has an X affordance that clears just that filter.
   */
  activeFilterChips = computed<ActiveFilterChip[]>(() => {
    const chips: ActiveFilterChip[] = [];
    const adv = this.advancedFilters();
    const category = this.categoryFilter();

    if (category) {
      chips.push({ key: 'category', label: `Category: ${CATEGORY_LABELS[category] ?? category}` });
    }
    if (adv.priority) {
      const labels = adv.priority
        .split(',')
        .map(p => PRIORITY_LABELS[p] ?? p)
        .join(', ');
      chips.push({ key: 'priority', label: `Priority: ${labels}` });
    }
    if (adv.clientId) {
      const client = this.clients().find(c => c.id === adv.clientId);
      chips.push({ key: 'clientId', label: `Client: ${client?.name ?? adv.clientId}` });
    }
    if (adv.source) {
      chips.push({ key: 'source', label: `Source: ${SOURCE_LABELS[adv.source] ?? adv.source}` });
    }
    if (adv.analysisStatus) {
      chips.push({ key: 'analysisStatus', label: `Analysis: ${ANALYSIS_STATUS_LABELS[adv.analysisStatus] ?? adv.analysisStatus}` });
    }
    if (adv.createdFrom || adv.createdTo) {
      const from = adv.createdFrom ? new Date(adv.createdFrom).toLocaleDateString() : '…';
      const to = adv.createdTo ? new Date(adv.createdTo).toLocaleDateString() : '…';
      chips.push({ key: 'dates', label: `Created: ${from} – ${to}` });
    }

    return chips;
  });

  trackById = (row: Ticket) => row.id;

  ngOnInit(): void {
    this.clientIdFilter.set(this.route.snapshot.queryParams['clientId'] ?? '');
    this.clientService.getClients().subscribe(clients => this.clients.set(clients));
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
    }).subscribe({
      next: tickets => this.tickets.set(tickets),
      error: err => this.toast.error(err.error?.error ?? 'Failed to load tickets'),
    });
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
    // Mirror the dialog's category into the standalone signal so presets
    // capture/restore it correctly. Always sync — including clearing.
    this.categoryFilter.set(filters.category);
    // Any explicit field edit means the user has diverged from the preset.
    // Picking a preset itself goes through onPresetSelected, not this method.
    this.selectedPresetId.set('');
    this.load();
  }

  openFilterDialog(): void {
    this.filterSnapshot = {
      statusFilter: this.statusFilter(),
      categoryFilter: this.categoryFilter(),
      clientIdFilter: this.clientIdFilter(),
      selectedPresetId: this.selectedPresetId(),
      advancedFilters: { ...this.advancedFilters() },
    };
    this.showFilterDialog.set(true);
  }

  /** Close the dialog and keep all live-applied changes. */
  closeFilterDialog(): void {
    this.filterSnapshot = null;
    this.showFilterDialog.set(false);
  }

  /** Revert all filter state to the snapshot taken when the dialog opened, then close. */
  cancelFilterDialog(): void {
    if (this.filterSnapshot) {
      const snap = this.filterSnapshot;
      this.statusFilter.set(snap.statusFilter);
      this.categoryFilter.set(snap.categoryFilter);
      this.clientIdFilter.set(snap.clientIdFilter);
      this.selectedPresetId.set(snap.selectedPresetId);
      this.advancedFilters.set(snap.advancedFilters);
      this.load();
    }
    this.filterSnapshot = null;
    this.showFilterDialog.set(false);
  }

  removeFilter(key: ActiveFilterChip['key']): void {
    const adv = this.advancedFilters();
    switch (key) {
      case 'category':
        this.categoryFilter.set('');
        this.advancedFilters.set({ ...adv, category: '' });
        break;
      case 'priority':
        this.advancedFilters.set({ ...adv, priority: '' });
        break;
      case 'clientId':
        this.advancedFilters.set({ ...adv, clientId: '' });
        break;
      case 'source':
        this.advancedFilters.set({ ...adv, source: '' });
        break;
      case 'analysisStatus':
        this.advancedFilters.set({ ...adv, analysisStatus: '' });
        break;
      case 'dates':
        this.advancedFilters.set({ ...adv, createdFrom: '', createdTo: '' });
        break;
    }
    this.selectedPresetId.set('');
    this.load();
  }

  clearAllAdvancedFilters(): void {
    this.advancedFilters.set({ ...EMPTY_ADVANCED_FILTERS });
    this.categoryFilter.set('');
    this.selectedPresetId.set('');
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
    // Also mirror category/client into `advancedFilters` so that:
    // (a) the dialog's seed-on-open reflects the active preset, and
    // (b) hitting Apply in the dialog doesn't emit empty values that would
    //     clobber the preset's filters.
    this.advancedFilters.update(adv => ({
      ...adv,
      category: preset.categoryFilter ?? '',
      clientId: preset.clientIdFilter ?? adv.clientId,
    }));
  }
}
