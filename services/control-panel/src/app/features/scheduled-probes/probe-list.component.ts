import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RouterLink } from '@angular/router';
import {
  DataTableComponent,
  DataTableColumnComponent,
  BroncoButtonComponent,
  ToolbarComponent,
  SelectComponent,
  ToggleSwitchComponent,
} from '../../shared/components/index.js';
import { DetailPanelService } from '../../core/services/detail-panel.service.js';
import { ScheduledProbeService, ScheduledProbe } from '../../core/services/scheduled-probe.service';
import { ClientService, Client } from '../../core/services/client.service';
import { CATEGORY_OPTIONS } from '../../core/services/client-memory.service';
import { ProbeDialogComponent } from './probe-dialog.component';

const CATEGORIES = CATEGORY_OPTIONS;

const ACTION_LABELS: Record<string, string> = {
  create_ticket: 'Create Ticket',
  email_direct: 'Email Direct',
  silent: 'Silent',
};

@Component({
  standalone: true,
  imports: [
    MatDialogModule,
    RouterLink,
    DataTableComponent,
    DataTableColumnComponent,
    BroncoButtonComponent,
    ToolbarComponent,
    SelectComponent,
    ToggleSwitchComponent,
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
          placeholder="All Clients"
          (valueChange)="onClientFilter($event)" />
      </app-toolbar>

      <app-data-table
        [data]="filteredProbes()"
        [trackBy]="trackById"
        (rowClick)="onProbeClick($event)"
        emptyMessage="No scheduled probes found">

        <app-data-column key="name" header="Name" [sortable]="false">
          <ng-template #cell let-row>
            <div>
              <span style="font-weight: 500; color: var(--text-primary);">{{ row.name }}</span>
              @if (row.description) {
                <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px;">{{ row.description }}</div>
              }
            </div>
          </ng-template>
        </app-data-column>

        <app-data-column key="client" header="Client" width="100px" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-size: 12px; padding: 2px 8px; background: var(--bg-active); border-radius: var(--radius-sm); color: var(--accent); font-family: ui-monospace, monospace;">
              {{ row.client?.shortCode ?? '—' }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="tool" header="Tool" width="160px" [sortable]="false">
          <ng-template #cell let-row>
            @if (isBuiltinTool(row.toolName)) {
              <span style="font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: var(--radius-sm); background: rgba(0,113,227,0.08); color: var(--accent);">Built-in</span>
            }
            <span style="font-size: 12px; padding: 2px 6px; background: var(--bg-muted); border-radius: var(--radius-sm); font-family: ui-monospace, monospace; color: var(--text-secondary);">
              {{ row.toolName }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="schedule" header="Schedule" width="180px" [sortable]="false">
          <ng-template #cell let-row>
            <span style="font-size: 13px; color: var(--text-secondary);" [title]="row.cronExpression">
              {{ humanReadableSchedule(row) }}
            </span>
          </ng-template>
        </app-data-column>

        <app-data-column key="action" header="Action" width="110px" [sortable]="false">
          <ng-template #cell let-row>
            <span class="action-badge" [class]="'action-' + row.action">{{ formatAction(row.action) }}</span>
          </ng-template>
        </app-data-column>

        <app-data-column key="lastRun" header="Last Run" width="140px" [sortable]="false">
          <ng-template #cell let-row>
            @if (row.lastRunAt) {
              <div style="font-size: 12px; color: var(--text-secondary);">{{ formatDate(row.lastRunAt) }}</div>
              <span class="run-status" [class]="'run-' + row.lastRunStatus">{{ row.lastRunStatus }}</span>
            } @else {
              <span style="font-size: 12px; color: var(--text-tertiary);">Never</span>
            }
          </ng-template>
        </app-data-column>

        <app-data-column key="active" header="Active" width="70px" [sortable]="false">
          <ng-template #cell let-row>
            <app-toggle-switch
              [checked]="row.isActive"
              (checkedChange)="toggleActive(row, $event)"
              (click)="$event.stopPropagation()" />
          </ng-template>
        </app-data-column>

        <app-data-column key="actions" header="" width="120px" [sortable]="false">
          <ng-template #cell let-row>
            <div style="display: flex; gap: 2px;" (click)="$event.stopPropagation()">
              <app-bronco-button variant="icon" size="sm" [routerLink]="['/scheduled-probes', row.id, 'runs']" title="Run history">&#x1F4CB;</app-bronco-button>
              <app-bronco-button variant="icon" size="sm" (click)="runNow(row)" title="Run now">&#x25B6;</app-bronco-button>
              <app-bronco-button variant="icon" size="sm" (click)="editProbe(row)" title="Edit">&#x270E;</app-bronco-button>
              <app-bronco-button variant="icon" size="sm" (click)="deleteProbe(row)" title="Delete">&#x2715;</app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>

      </app-data-table>
    </div>
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
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private detailPanel = inject(DetailPanelService);

  probes = signal<ScheduledProbe[]>([]);
  clients = signal<Client[]>([]);
  private builtinToolNames = new Set<string>();

  filterClientId = signal('');

  trackById = (item: any) => item.id;

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

  onProbeClick(probe: any): void {
    this.detailPanel.open('probe', probe.id);
  }

  formatAction(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    const ref = this.dialog.open(ProbeDialogComponent, {
      width: '600px',
      data: { clients: this.clients(), categories: CATEGORIES },
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.loadProbes();
    });
  }

  editProbe(probe: ScheduledProbe): void {
    const ref = this.dialog.open(ProbeDialogComponent, {
      width: '600px',
      data: { probe, clients: this.clients(), categories: CATEGORIES },
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.loadProbes();
    });
  }

  toggleActive(probe: ScheduledProbe, isActive: boolean): void {
    this.probeService.updateProbe(probe.id, { isActive }).subscribe({
      next: () => {
        this.snackBar.open(`Probe ${isActive ? 'activated' : 'deactivated'}`, 'OK', { duration: 3000 });
        this.loadProbes();
      },
      error: () => this.snackBar.open('Failed to update probe', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  runNow(probe: ScheduledProbe): void {
    this.probeService.runProbe(probe.id).subscribe({
      next: () => this.snackBar.open('Probe execution queued', 'OK', { duration: 3000 }),
      error: () => this.snackBar.open('Failed to queue probe', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  deleteProbe(probe: ScheduledProbe): void {
    if (!confirm(`Delete probe "${probe.name}"?`)) return;
    this.probeService.deleteProbe(probe.id).subscribe({
      next: () => {
        this.snackBar.open('Probe deleted', 'OK', { duration: 3000 });
        this.loadProbes();
      },
      error: () => this.snackBar.open('Failed to delete probe', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
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
