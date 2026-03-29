import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DatePipe, SlicePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
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
    FormsModule,
    MatCardModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    MatTooltipModule,
    MatSelectModule,
    MatFormFieldModule,
    MatChipsModule,
    MatDialogModule,
    RouterLink,
    DatePipe,
    SlicePipe,
  ],
  template: `
    <div class="page-header">
      <h1>Scheduled Probes</h1>
      <button mat-raised-button color="primary" (click)="addProbe()">
        <mat-icon>add</mat-icon> Add Probe
      </button>
    </div>

    <div class="filters">
      <mat-form-field appearance="outline" class="filter-field">
        <mat-label>Client</mat-label>
        <mat-select [(ngModel)]="filterClientId" (selectionChange)="loadProbes()">
          <mat-option value="">All Clients</mat-option>
          @for (c of clients(); track c.id) {
            <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </div>

    @if (probes().length === 0) {
      <mat-card class="empty-card">
        <p class="empty">No scheduled probes found. Create a probe to run MCP tools on a schedule.</p>
      </mat-card>
    } @else {
      <table mat-table [dataSource]="probes()" class="full-width probe-table">
        <ng-container matColumnDef="name">
          <th mat-header-cell *matHeaderCellDef>Name</th>
          <td mat-cell *matCellDef="let p">
            <a class="probe-name" [routerLink]="['/scheduled-probes', p.id, 'runs']">{{ p.name }}</a>
            @if (p.description) {
              <div class="probe-desc">{{ p.description }}</div>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="client">
          <th mat-header-cell *matHeaderCellDef>Client</th>
          <td mat-cell *matCellDef="let p">
            @if (p.client) {
              <span class="badge badge-client">{{ p.client.shortCode }}</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="tool">
          <th mat-header-cell *matHeaderCellDef>Tool</th>
          <td mat-cell *matCellDef="let p">
            @if (isBuiltinTool(p.toolName)) {
              <span class="badge badge-builtin">Built-in</span>
            }
            <span class="tool-chip">{{ p.toolName }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="schedule">
          <th mat-header-cell *matHeaderCellDef>Schedule</th>
          <td mat-cell *matCellDef="let p">
            <span class="cron-text" [matTooltip]="p.cronExpression">{{ describeSchedule(p) }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="action">
          <th mat-header-cell *matHeaderCellDef>Action</th>
          <td mat-cell *matCellDef="let p">
            <span class="badge" [class]="'badge-' + p.action">{{ actionLabel(p.action) }}</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="lastRun">
          <th mat-header-cell *matHeaderCellDef>Last Run</th>
          <td mat-cell *matCellDef="let p">
            @if (p.lastRunAt) {
              <div class="last-run">
                <span class="run-time">{{ p.lastRunAt | date:'short' }}</span>
                <span class="badge" [class]="'badge-status-' + p.lastRunStatus">{{ p.lastRunStatus }}</span>
              </div>
              @if (p.lastRunResult) {
                <div class="run-result" [matTooltip]="p.lastRunResult">{{ p.lastRunResult | slice:0:80 }}</div>
              }
            } @else {
              <span class="muted">Never</span>
            }
          </td>
        </ng-container>

        <ng-container matColumnDef="active">
          <th mat-header-cell *matHeaderCellDef>Active</th>
          <td mat-cell *matCellDef="let p">
            <mat-slide-toggle
              [checked]="p.isActive"
              (change)="toggleActive(p)"
              color="primary">
            </mat-slide-toggle>
          </td>
        </ng-container>

        <ng-container matColumnDef="actions">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let p">
            <a mat-icon-button matTooltip="History" aria-label="View run history" [routerLink]="['/scheduled-probes', p.id, 'runs']">
              <mat-icon>history</mat-icon>
            </a>
            <button mat-icon-button matTooltip="Run now" (click)="runNow(p)">
              <mat-icon>play_arrow</mat-icon>
            </button>
            <button mat-icon-button matTooltip="Edit" (click)="editProbe(p)">
              <mat-icon>edit</mat-icon>
            </button>
            <button mat-icon-button color="warn" matTooltip="Delete" (click)="deleteProbe(p)">
              <mat-icon>delete</mat-icon>
            </button>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns;"></tr>
      </table>
    }
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .filters { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .filter-field { min-width: 200px; }
    .probe-table { width: 100%; }
    .probe-name { font-weight: 500; color: #1565c0; text-decoration: none; }
    .probe-name:hover { text-decoration: underline; }
    .probe-desc { font-size: 12px; color: #666; margin-top: 2px; }
    .tool-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; background: #e8eaf6; color: #3f51b5; font-family: monospace; }
    .cron-text { font-family: monospace; font-size: 13px; }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .badge-client { background: #fff3e0; color: #e65100; }
    .badge-create_ticket { background: #e8f5e9; color: #2e7d32; }
    .badge-email_direct { background: #e3f2fd; color: #1565c0; }
    .badge-silent { background: #f5f5f5; color: #777; }
    .badge-builtin { background: #ede7f6; color: #6a1b9a; margin-right: 4px; }
    .badge-status-success { background: #e8f5e9; color: #2e7d32; }
    .badge-status-error { background: #ffebee; color: #c62828; }
    .badge-status-skipped { background: #fff3e0; color: #e65100; }
    .last-run { display: flex; align-items: center; gap: 6px; }
    .run-time { font-size: 12px; color: #555; }
    .run-result { font-size: 11px; color: #888; margin-top: 2px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: #999; }
    .empty { color: #999; text-align: center; padding: 24px 16px; margin: 0; }
    .empty-card { margin-bottom: 16px; }
    .full-width { width: 100%; }
  `],
})
export class ProbeListComponent implements OnInit {
  private probeService = inject(ScheduledProbeService);
  private clientService = inject(ClientService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  probes = signal<ScheduledProbe[]>([]);
  clients = signal<Client[]>([]);
  private builtinToolNames = new Set<string>();

  filterClientId = '';
  columns = ['name', 'client', 'tool', 'schedule', 'action', 'lastRun', 'active', 'actions'];

  ngOnInit(): void {
    this.clientService.getClients().subscribe((c) => this.clients.set(c));
    this.probeService.getBuiltinTools().subscribe((tools) => {
      for (const t of tools) this.builtinToolNames.add(t.name);
    });
    this.loadProbes();
  }

  loadProbes(): void {
    const filters: Record<string, string> = {};
    if (this.filterClientId) filters['clientId'] = this.filterClientId;
    this.probeService.getProbes(filters).subscribe((probes) => this.probes.set(probes));
  }

  actionLabel(action: string): string {
    return ACTION_LABELS[action] ?? action;
  }

  isBuiltinTool(toolName: string): boolean {
    return this.builtinToolNames.has(toolName);
  }

  describeSchedule(probe: ScheduledProbe): string {
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

  toggleActive(probe: ScheduledProbe): void {
    this.probeService.updateProbe(probe.id, { isActive: !probe.isActive }).subscribe({
      next: () => {
        this.snackBar.open(`Probe ${probe.isActive ? 'deactivated' : 'activated'}`, 'OK', { duration: 3000 });
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
