import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  DataTableComponent,
  DataTableColumnComponent,
  BroncoButtonComponent,
  ToolbarComponent,
  SelectComponent,
  ToggleSwitchComponent,
  IconComponent,
} from '../../shared/components/index.js';
import { DialogComponent } from '../../shared/components/dialog.component';
import { DetailPanelService } from '../../core/services/detail-panel.service.js';
import { ScheduledProbeService, ScheduledProbe } from '../../core/services/scheduled-probe.service';
import { ClientService, Client } from '../../core/services/client.service';
import { CATEGORY_OPTIONS } from '../../core/services/client-memory.service';
import { ProbeDialogComponent } from './probe-dialog.component';
import { ToastService } from '../../core/services/toast.service';

const CATEGORIES = CATEGORY_OPTIONS;

const ACTION_LABELS: Record<string, string> = {
  create_ticket: 'Create Ticket',
  email_direct: 'Email Direct',
  silent: 'Silent',
};

@Component({
  standalone: true,
  imports: [
    NgClass,
    RouterLink,
    DataTableComponent,
    DataTableColumnComponent,
    BroncoButtonComponent,
    ToolbarComponent,
    SelectComponent,
    DialogComponent,
    ProbeDialogComponent,
    ToggleSwitchComponent,
    IconComponent,
  ],
  template: `
    <div class="probe-list-page">
      <div class="page-header">
        <h1 class="page-title">Scheduled Probes</h1>
        <app-bronco-button variant="primary" (click)="addProbe()">+ New Probe</app-bronco-button>
      </div>

      <app-toolbar>
        <app-select
          [value]="filterClientId()"
          [options]="clientOptions()"
          (valueChange)="onClientFilter($event)" />
      </app-toolbar>

      <app-data-table
        [data]="filteredProbes()"
        [trackBy]="trackById"
        (rowClick)="onProbeClick($event)"
        emptyMessage="No scheduled probes found">

        <app-data-column key="name" header="Name" [sortable]="false" mobilePriority="primary">
          <ng-template #cell let-row>
            <span style="font-weight: 500; color: var(--text-primary);">{{ row.name }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="client" header="Client" width="100px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            <span style="font-size: 12px; padding: 2px 8px; background: var(--bg-active); border-radius: var(--radius-sm); color: var(--accent); font-family: ui-monospace, monospace;">
              {{ row.client?.shortCode ?? '—' }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="tool" header="Tool" width="160px" [sortable]="false" mobilePriority="hidden">
          <ng-template #cell let-row>
            @if (isBuiltinTool(row.toolName)) {
              <span style="font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: var(--radius-sm); background: rgba(0,113,227,0.08); color: var(--accent);">Built-in</span>
            }
            <span style="font-size: 12px; padding: 2px 6px; background: var(--bg-muted); border-radius: var(--radius-sm); font-family: ui-monospace, monospace; color: var(--text-secondary);">
              {{ row.toolName }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="schedule" header="Schedule" width="180px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            <span style="font-size: 13px; color: var(--text-secondary);" [title]="row.cronExpression">
              {{ humanReadableSchedule(row) }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="action" header="Action" width="110px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            <span class="action-badge" [ngClass]="'action-' + row.action">{{ formatAction(row.action) }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="lastRun" header="Last Run" width="140px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            @if (row.lastRunAt) {
              <div style="font-size: 12px; color: var(--text-secondary);">{{ formatDate(row.lastRunAt) }}</div>
              <span class="run-status" [ngClass]="'run-' + row.lastRunStatus">{{ row.lastRunStatus }}</span>
            } @else {
              <span style="font-size: 12px; color: var(--text-tertiary);">Never</span>
            }
          </ng-template>
        </app-data-column>

        <app-data-column key="active" header="Active" width="70px" [sortable]="false" mobilePriority="secondary">
          <ng-template #cell let-row>
            <app-toggle-switch
              [checked]="row.isActive"
              (checkedChange)="toggleActive(row, $event)"
              (click)="$event.stopPropagation()" />
          </ng-template>
        </app-data-column>

        <app-data-column key="actions" header="" width="120px" [sortable]="false" mobilePriority="hidden">
          <ng-template #cell let-row>
            <div style="display: flex; gap: 2px;" (click)="$event.stopPropagation()">
              <app-bronco-button variant="icon" size="sm" aria-label="Run history" [routerLink]="['/scheduled-probes', row.id, 'runs']" title="Run history"><app-icon name="clipboard" size="sm" /></app-bronco-button>
              <app-bronco-button variant="icon" size="sm" aria-label="Run now" (click)="runNow(row)" title="Run now"><app-icon name="play" size="sm" /></app-bronco-button>
              <app-bronco-button variant="icon" size="sm" aria-label="Edit" (click)="editProbe(row)" title="Edit"><app-icon name="edit" size="sm" /></app-bronco-button>
              <app-bronco-button variant="icon" size="sm" aria-label="Delete" (click)="deleteProbe(row)" title="Delete"><app-icon name="close" size="sm" /></app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>

        <ng-template #subtitle let-row>
          @if (row.description) {
            {{ row.description }}
          }
        </ng-template>
      </app-data-table>
    </div>

    @if (showProbeDialog()) {
      <app-dialog [open]="true" [title]="editingProbe() ? 'Edit Probe' : 'Create Probe'" maxWidth="600px" (openChange)="showProbeDialog.set(false)">
        <app-probe-dialog-content
          [probe]="editingProbe() ?? undefined"
          [clients]="clients()"
          [categories]="categories"
          (saved)="onProbeSaved()"
          (cancelled)="showProbeDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    .probe-list-page { max-width: 1200px; }
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-title { font-family: var(--font-primary); font-size: 20px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .action-badge { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: var(--radius-sm); }
    .action-create_ticket { background: rgba(0,122,255,0.08); color: var(--color-info); }
    .action-email_direct { background: rgba(255,149,0,0.08); color: var(--color-warning); }
    .action-silent { background: var(--bg-muted); color: var(--text-tertiary); }
    .run-status { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: var(--radius-sm); }
    .run-success { background: rgba(52,199,89,0.08); color: var(--color-success); }
    .run-error { background: rgba(255,59,48,0.08); color: var(--color-error); }
    .run-skipped { background: var(--bg-muted); color: var(--text-tertiary); }
  `],
})
export class ProbeListComponent implements OnInit {
  private probeService = inject(ScheduledProbeService);
  private clientService = inject(ClientService);
  private toast = inject(ToastService);
  private detailPanel = inject(DetailPanelService);

  showProbeDialog = signal(false);
  editingProbe = signal<ScheduledProbe | null>(null);
  categories = CATEGORIES;

  probes = signal<ScheduledProbe[]>([]);
  clients = signal<Client[]>([]);
  private builtinToolNames = new Set<string>();

  filterClientId = signal('');

  trackById = (item: ScheduledProbe) => item.id;

  clientOptions = computed(() => [
    { value: '', label: 'All Clients' },
    ...this.clients().map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
  ]);

  filteredProbes = computed(() => {
    const cid = this.filterClientId();
    return cid ? this.probes().filter(p => p.clientId === cid) : this.probes();
  });

  ngOnInit(): void {
    this.clientService.getClients().subscribe((c) => this.clients.set(c));
    this.probeService.getBuiltinTools().subscribe((tools) => {
      for (const t of tools) this.builtinToolNames.add(t.name);
    });
    this.loadProbes();
  }

  loadProbes(): void {
    this.probeService.getProbes({}).subscribe((probes) => this.probes.set(probes));
  }

  onClientFilter(value: string): void {
    this.filterClientId.set(value);
  }

  onProbeClick(probe: ScheduledProbe): void {
    this.detailPanel.open('probe', probe.id);
  }

  formatAction(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  isBuiltinTool(toolName: string): boolean {
    return this.builtinToolNames.has(toolName);
  }

  humanReadableSchedule(probe: ScheduledProbe): string {
    if (probe.scheduleTimezone && probe.scheduleHour !== null) {
      return formatTimezoneSchedule(probe.scheduleHour, probe.scheduleMinute ?? 0, probe.scheduleDaysOfWeek, probe.scheduleTimezone);
    }
    return this.describeCron(probe.cronExpression);
  }

  describeCron(expr: string): string {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return expr;
    const [min, hour, dom, mon, dow] = parts;
    if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
    if (min === '0' && hour?.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') return `Every ${hour.slice(2)}h`;
    if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow === '*') return `Daily ${hour}:${min.padStart(2, '0')}`;
    if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow !== '*') {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `${days[Number(dow)] ?? dow} ${hour}:${min.padStart(2, '0')}`;
    }
    return expr;
  }

  addProbe(): void {
    this.editingProbe.set(null);
    this.showProbeDialog.set(true);
  }

  editProbe(probe: ScheduledProbe): void {
    this.editingProbe.set(probe);
    this.showProbeDialog.set(true);
  }

  onProbeSaved(): void {
    this.showProbeDialog.set(false);
    this.loadProbes();
  }

  toggleActive(probe: ScheduledProbe, isActive: boolean): void {
    this.probeService.updateProbe(probe.id, { isActive }).subscribe({
      next: () => {
        this.toast.success(`Probe ${isActive ? 'activated' : 'deactivated'}`);
        this.loadProbes();
      },
      error: () => this.toast.error('Failed to update probe'),
    });
  }

  runNow(probe: ScheduledProbe): void {
    this.probeService.runProbe(probe.id).subscribe({
      next: () => this.toast.success('Probe execution queued'),
      error: () => this.toast.error('Failed to queue probe'),
    });
  }

  deleteProbe(probe: ScheduledProbe): void {
    if (!confirm(`Delete probe "${probe.name}"?`)) return;
    this.probeService.deleteProbe(probe.id).subscribe({
      next: () => {
        this.toast.success('Probe deleted');
        this.loadProbes();
      },
      error: () => this.toast.error('Failed to delete probe'),
    });
  }
}

function formatTimezoneSchedule(hour: number, minute: number, daysOfWeek: string | null, timezone: string): string {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const time = `${h12}:${minute.toString().padStart(2, '0')} ${ampm}`;

  // Short timezone abbreviation
  let tzAbbr: string;
  try {
    tzAbbr = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    tzAbbr = timezone;
  }

  if (!daysOfWeek) return `Daily at ${time} ${tzAbbr}`;

  const days = daysOfWeek.split(',').map(Number);
  // Check for weekdays pattern
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
    return `Mon-Fri at ${time} ${tzAbbr}`;
  }
  // Check for weekends
  if (days.length === 2 && days.includes(0) && days.includes(6)) {
    return `Sat-Sun at ${time} ${tzAbbr}`;
  }
  const dayStr = days.map((d) => DAY_NAMES[d] ?? String(d)).join(', ');
  return `${dayStr} at ${time} ${tzAbbr}`;
}
