import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { ScheduledProbeService, ScheduledProbe, CreateProbeRequest, UpdateProbeRequest } from '../../core/services/scheduled-probe.service';
import { IntegrationService, ClientIntegration } from '../../core/services/integration.service';
import { Client } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';

interface ToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface DialogData {
  probe?: ScheduledProbe;
  clients: Client[];
  categories: Array<{ value: string; label: string }>;
}

const ACTIONS = [
  { value: 'create_ticket', label: 'Create Ticket' },
  { value: 'email_direct', label: 'Email Direct' },
  { value: 'silent', label: 'Silent (ticket only if actionable)' },
];

const CRON_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily at 2 AM', value: '0 2 * * *' },
  { label: 'Daily at 8 AM', value: '0 8 * * *' },
  { label: 'Every Monday at 9 AM', value: '0 9 * * 1' },
  { label: 'Custom', value: '' },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const h12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
  const ampm = i < 12 ? 'AM' : 'PM';
  return { value: i, label: `${h12}:00 ${ampm}` };
});

const MINUTE_OPTIONS = [0, 15, 30, 45].map((m) => ({ value: m, label: m.toString().padStart(2, '0') }));

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const COMMON_TIMEZONES = [
  { value: 'America/New_York', label: 'America/New_York (Eastern)' },
  { value: 'America/Chicago', label: 'America/Chicago (Central)' },
  { value: 'America/Denver', label: 'America/Denver (Mountain)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (Pacific)' },
  { value: 'UTC', label: 'UTC' },
];

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatSlideToggleModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Edit Probe' : 'Create Probe' }}</h2>
    <mat-dialog-content class="dialog-content">
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Name</mat-label>
        <input matInput [(ngModel)]="name" required placeholder="e.g. Daily Blocking Check">
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Description</mat-label>
        <textarea matInput [(ngModel)]="description" rows="2" placeholder="Optional description"></textarea>
      </mat-form-field>

      @if (!isEdit) {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Client</mat-label>
          <mat-select [(ngModel)]="clientId" (selectionChange)="onClientChange()" required>
            @for (c of data.clients; track c.id) {
              <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Tool Source</mat-label>
          <mat-select [(ngModel)]="toolSource" (selectionChange)="onToolSourceChange()">
            <mat-option value="mcp">MCP Integration</mat-option>
            <mat-option value="builtin">Built-in</mat-option>
          </mat-select>
        </mat-form-field>

        @if (toolSource === 'mcp') {
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Integration</mat-label>
            <mat-select [(ngModel)]="integrationId" (selectionChange)="onIntegrationChange()" required [disabled]="!clientId">
              @for (integ of filteredIntegrations; track integ.id) {
                <mat-option [value]="integ.id">{{ integ.label }} ({{ integ.type }})</mat-option>
              }
            </mat-select>
          </mat-form-field>
        }

      }

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Tool</mat-label>
        <mat-select [(ngModel)]="toolName" (selectionChange)="onToolChange()" required [disabled]="toolSource === 'mcp' ? !integrationId : false">
          @for (t of availableTools; track t.name) {
            <mat-option [value]="t.name">{{ t.name }} — {{ t.description }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      @if (toolParamFields.length > 0) {
        <div class="params-section">
          <h4>Tool Parameters</h4>
          @for (field of toolParamFields; track field.name) {
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>{{ field.name }}</mat-label>
              @if (field.type === 'number') {
                <input matInput type="number" [(ngModel)]="toolParams[field.name]" [placeholder]="field.description">
              } @else {
                <input matInput [(ngModel)]="toolParams[field.name]" [placeholder]="field.description">
              }
              @if (field.description) {
                <mat-hint>{{ field.description }}</mat-hint>
              }
            </mat-form-field>
          }
        </div>
      }

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Schedule Type</mat-label>
        <mat-select [(ngModel)]="scheduleType" (selectionChange)="onScheduleTypeChange()">
          <mat-option value="time">Time-based (recommended)</mat-option>
          <mat-option value="cron">Custom cron</mat-option>
        </mat-select>
      </mat-form-field>

      @if (scheduleType === 'time') {
        <div class="time-row">
          <mat-form-field appearance="outline" class="time-field">
            <mat-label>Hour</mat-label>
            <mat-select [(ngModel)]="scheduleHour">
              @for (h of hourOptions; track h.value) {
                <mat-option [value]="h.value">{{ h.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" class="time-field">
            <mat-label>Minute</mat-label>
            <mat-select [(ngModel)]="scheduleMinute">
              @for (m of minuteOptions; track m.value) {
                <mat-option [value]="m.value">{{ m.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>

        <div class="days-section">
          <label class="days-label">Days</label>
          <div class="days-row">
            @for (day of dayNames; track $index) {
              <mat-checkbox
                [checked]="selectedDays[$index]"
                (change)="selectedDays[$index] = $event.checked"
                color="primary">
                {{ day }}
              </mat-checkbox>
            }
          </div>
          <span class="days-hint">Leave all unchecked for every day</span>
        </div>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Timezone</mat-label>
          <mat-select [(ngModel)]="scheduleTimezone">
            @for (tz of commonTimezones; track tz.value) {
              <mat-option [value]="tz.value">{{ tz.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <div class="utc-hint">Next run: {{ computedUtcTime }} UTC</div>
      }

      @if (scheduleType === 'cron') {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Schedule Preset</mat-label>
          <mat-select [(ngModel)]="cronPreset" (selectionChange)="onPresetChange()">
            @for (p of cronPresets; track p.value) {
              <mat-option [value]="p.value">{{ p.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Cron Expression</mat-label>
          <input matInput [(ngModel)]="cronExpression" required placeholder="0 * * * *">
          <mat-hint>{{ cronHumanReadable }}</mat-hint>
        </mat-form-field>
      }

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Action</mat-label>
        <mat-select [(ngModel)]="action">
          @for (a of actions; track a.value) {
            <mat-option [value]="a.value">{{ a.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      @if (action === 'create_ticket' || action === 'silent') {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Operator Email</mat-label>
          <input matInput [(ngModel)]="operatorEmail" type="email" placeholder="operator@example.com">
          <mat-hint>Operator who will receive ticket updates and findings</mat-hint>
        </mat-form-field>
      }

      @if (action === 'email_direct') {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Email To</mat-label>
          <input matInput [(ngModel)]="emailTo" type="email" placeholder="recipient@example.com">
        </mat-form-field>
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Email Subject</mat-label>
          <input matInput [(ngModel)]="emailSubject" placeholder="Optional custom subject">
        </mat-form-field>
      }

      @if (action !== 'email_direct') {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Category</mat-label>
          <mat-select [(ngModel)]="category">
            <mat-option [value]="null">None</mat-option>
            @for (cat of data.categories; track cat.value) {
              <mat-option [value]="cat.value">{{ cat.label }}</mat-option>
            }
          </mat-select>
          <mat-hint>Category assigned to tickets created by this probe.</mat-hint>
        </mat-form-field>
      }

      @if (isEdit) {
        <div class="retention-section">
          <h4>Retention Settings</h4>
          <div class="retention-row">
            <mat-form-field appearance="outline" class="retention-field">
              <mat-label>Retention Days</mat-label>
              <input matInput type="number" [(ngModel)]="retentionDays" min="1" max="365">
            </mat-form-field>
            <mat-form-field appearance="outline" class="retention-field">
              <mat-label>Max Runs</mat-label>
              <input matInput type="number" [(ngModel)]="retentionMaxRuns" min="5" max="10000">
            </mat-form-field>
          </div>
        </div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave() || saving">
        {{ saving ? 'Saving...' : (isEdit ? 'Update' : 'Create') }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-content { min-width: 450px; }
    .full-width { width: 100%; margin-bottom: 8px; }
    .params-section { margin-bottom: 8px; }
    .params-section h4 { margin: 0 0 8px; font-size: 14px; color: #555; }
    .time-row { display: flex; gap: 12px; }
    .time-field { flex: 1; }
    .days-section { margin-bottom: 16px; }
    .days-label { font-size: 12px; color: rgba(0,0,0,.6); display: block; margin-bottom: 4px; }
    .days-row { display: flex; gap: 4px; flex-wrap: wrap; }
    .days-hint { font-size: 11px; color: #999; display: block; margin-top: 2px; }
    .utc-hint { font-size: 12px; color: #1565c0; margin-bottom: 12px; padding: 4px 8px; background: #e3f2fd; border-radius: 4px; }
    .retention-section { margin-top: 8px; }
    .retention-section h4 { margin: 0 0 8px; font-size: 14px; color: #555; }
    .retention-row { display: flex; gap: 12px; }
    .retention-field { flex: 1; }
  `],
})
export class ProbeDialogComponent implements OnInit {
  data = inject<DialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<ProbeDialogComponent>);
  private probeService = inject(ScheduledProbeService);
  private integrationService = inject(IntegrationService);
  private toast = inject(ToastService);

  isEdit = !!this.data.probe;
  name = this.data.probe?.name ?? '';
  description = this.data.probe?.description ?? '';
  clientId = this.data.probe?.clientId ?? '';
  integrationId = this.data.probe?.integrationId ?? '';
  toolName = this.data.probe?.toolName ?? '';
  toolParams: Record<string, unknown> = { ...(this.data.probe?.toolParams ?? {}) };
  cronExpression = this.data.probe?.cronExpression ?? '0 * * * *';
  cronPreset = '';
  category: string | null = this.data.probe?.category ?? null;
  action = this.data.probe?.action ?? 'create_ticket';
  operatorEmail = '';
  emailTo = '';
  emailSubject = '';
  retentionDays = this.data.probe?.retentionDays ?? 30;
  retentionMaxRuns = this.data.probe?.retentionMaxRuns ?? 100;
  saving = false;

  // Schedule type: 'time' for timezone-based, 'cron' for raw cron
  scheduleType: 'time' | 'cron' = !this.data.probe ? 'time' : (this.data.probe.scheduleTimezone ? 'time' : 'cron');
  scheduleHour = this.data.probe?.scheduleHour ?? 8;
  scheduleMinute = this.data.probe?.scheduleMinute ?? 0;
  scheduleTimezone = this.data.probe?.scheduleTimezone ?? 'America/Chicago';
  selectedDays: boolean[] = [false, false, false, false, false, false, false];

  actions = ACTIONS;
  cronPresets = CRON_PRESETS;
  hourOptions = HOUR_OPTIONS;
  minuteOptions = MINUTE_OPTIONS;
  dayNames = DAY_NAMES;
  commonTimezones = COMMON_TIMEZONES;

  toolSource: 'mcp' | 'builtin' = 'mcp';

  allIntegrations: ClientIntegration[] = [];
  filteredIntegrations: ClientIntegration[] = [];
  builtinTools: ToolInfo[] = [];
  availableTools: ToolInfo[] = [];
  toolParamFields: Array<{ name: string; type: string; description: string }> = [];

  get cronHumanReadable(): string {
    return describeCron(this.cronExpression);
  }

  get computedUtcTime(): string {
    return computeUtcPreview(this.scheduleHour, this.scheduleMinute, this.selectedDays, this.scheduleTimezone);
  }

  ngOnInit(): void {
    // Load action config from existing probe
    if (this.data.probe?.actionConfig) {
      const cfg = this.data.probe.actionConfig;
      this.operatorEmail = typeof cfg['operatorEmail'] === 'string' ? cfg['operatorEmail'] : '';
      this.emailTo = typeof cfg['emailTo'] === 'string' ? cfg['emailTo'] : '';
      this.emailSubject = typeof cfg['emailSubject'] === 'string' ? cfg['emailSubject'] : '';
    }

    // Populate days of week from existing probe
    if (this.data.probe?.scheduleDaysOfWeek) {
      const days = this.data.probe.scheduleDaysOfWeek.split(',').map(Number);
      for (const d of days) {
        if (d >= 0 && d <= 6) this.selectedDays[d] = true;
      }
    }

    // Set cron preset if it matches
    const match = CRON_PRESETS.find((p) => p.value === this.cronExpression);
    this.cronPreset = match ? match.value : '';

    // Load built-in tools
    this.probeService.getBuiltinTools().subscribe((tools) => {
      this.builtinTools = tools;
      // If editing and the tool is built-in, select that source
      if (this.isEdit && this.toolName && tools.some((t) => t.name === this.toolName)) {
        this.toolSource = 'builtin';
        this.availableTools = this.builtinTools;
        // Rebuild param fields but preserve existing values
        const existingParams = this.toolParams;
        this.onToolChange();
        if (existingParams) this.toolParams = existingParams;
      } else if (this.toolSource === 'builtin') {
        // Create mode: user already switched to builtin before load finished
        this.availableTools = this.builtinTools;
      }
    });

    // Load integrations
    this.integrationService.getIntegrations().subscribe((integs) => {
      this.allIntegrations = integs.filter((i) => i.type === 'MCP_DATABASE' && i.isActive);
      if (this.clientId) {
        this.filteredIntegrations = this.allIntegrations.filter((i) => i.clientId === this.clientId);
      }
      if (this.integrationId && this.toolSource === 'mcp') {
        this.loadToolsFromIntegration();
      }
    });
  }

  onClientChange(): void {
    this.filteredIntegrations = this.allIntegrations.filter((i) => i.clientId === this.clientId);
    this.integrationId = '';
    this.toolName = '';
    if (this.toolSource === 'mcp') {
      this.availableTools = [];
    }
    this.toolParamFields = [];
  }

  onToolSourceChange(): void {
    this.toolName = '';
    this.toolParamFields = [];
    this.toolParams = {};
    if (this.toolSource === 'builtin') {
      this.availableTools = this.builtinTools;
    } else {
      this.availableTools = [];
      if (this.integrationId) {
        this.loadToolsFromIntegration();
      }
    }
  }

  onIntegrationChange(): void {
    this.toolName = '';
    this.toolParamFields = [];
    this.loadToolsFromIntegration();
  }

  onToolChange(): void {
    const tool = this.availableTools.find((t) => t.name === this.toolName);
    this.toolParamFields = [];
    this.toolParams = {};
    if (tool?.inputSchema) {
      const props = (tool.inputSchema['properties'] ?? {}) as Record<string, { type?: string; description?: string }>;
      for (const [key, schema] of Object.entries(props)) {
        this.toolParamFields.push({
          name: key,
          type: schema.type ?? 'string',
          description: schema.description ?? '',
        });
      }
    }
  }

  onScheduleTypeChange(): void {
    // no-op, just triggers re-render
  }

  onPresetChange(): void {
    if (this.cronPreset) {
      this.cronExpression = this.cronPreset;
    }
  }

  canSave(): boolean {
    if (!this.name.trim() || !this.toolName) return false;
    if (this.toolSource === 'mcp' && !this.integrationId) return false;
    if (this.scheduleType === 'cron' && !this.cronExpression.trim()) return false;
    if (!this.isValidRetention(this.retentionDays, 1, 365)) return false;
    if (!this.isValidRetention(this.retentionMaxRuns, 5, 10000)) return false;
    return true;
  }

  private isValidRetention(val: unknown, min: number, max: number): val is number {
    return typeof val === 'number' && Number.isFinite(val) && Number.isInteger(val) && val >= min && val <= max;
  }

  save(): void {
    if (!this.canSave()) return;
    this.saving = true;

    // Build actionConfig
    let actionConfig: Record<string, unknown> | null = null;
    if (this.action === 'email_direct') {
      actionConfig = {};
      if (this.emailTo) actionConfig['emailTo'] = this.emailTo;
      if (this.emailSubject) actionConfig['emailSubject'] = this.emailSubject;
    } else if (this.action === 'create_ticket' || this.action === 'silent') {
      if (this.operatorEmail) {
        actionConfig = { operatorEmail: this.operatorEmail };
      }
    }

    // Strip empty string params
    const cleanParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.toolParams)) {
      if (v !== '' && v !== undefined && v !== null) {
        cleanParams[k] = v;
      }
    }

    // Build days-of-week string
    const daysOfWeek = this.buildDaysOfWeek();

    if (this.isEdit) {
      const updateData: UpdateProbeRequest = {
        name: this.name.trim(),
        description: this.description.trim() || null,
        category: this.category,
        action: this.action,
        actionConfig,
        retentionDays: this.isValidRetention(this.retentionDays, 1, 365)
          ? Math.round(this.retentionDays) : undefined,
        retentionMaxRuns: this.isValidRetention(this.retentionMaxRuns, 5, 10000)
          ? Math.round(this.retentionMaxRuns) : undefined,
      };
      if (this.scheduleType === 'time') {
        updateData.scheduleHour = this.scheduleHour;
        updateData.scheduleMinute = this.scheduleMinute;
        updateData.scheduleDaysOfWeek = daysOfWeek;
        updateData.scheduleTimezone = this.scheduleTimezone;
      } else {
        updateData.cronExpression = this.cronExpression;
        updateData.scheduleTimezone = null;
      }
      this.probeService.updateProbe(this.data.probe!.id, updateData).subscribe({
        next: () => {
          this.toast.success('Probe updated');
          this.dialogRef.close(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.message ?? 'Failed to update probe');
        },
      });
    } else {
      const req: CreateProbeRequest = {
        clientId: this.clientId,
        integrationId: this.toolSource === 'mcp' ? this.integrationId : undefined,
        name: this.name.trim(),
        description: this.description.trim() || undefined,
        toolName: this.toolName,
        toolParams: cleanParams,
        category: this.category,
        action: this.action,
        actionConfig,
      };
      if (this.scheduleType === 'time') {
        req.scheduleHour = this.scheduleHour;
        req.scheduleMinute = this.scheduleMinute;
        req.scheduleDaysOfWeek = daysOfWeek;
        req.scheduleTimezone = this.scheduleTimezone;
      } else {
        req.cronExpression = this.cronExpression;
      }
      this.probeService.createProbe(req).subscribe({
        next: () => {
          this.toast.success('Probe created');
          this.dialogRef.close(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.message ?? 'Failed to create probe');
        },
      });
    }
  }

  private buildDaysOfWeek(): string | null {
    const selected = this.selectedDays
      .map((checked, i) => (checked ? i : -1))
      .filter((i) => i >= 0);
    if (selected.length === 0) return null;
    return selected.join(',');
  }

  private loadToolsFromIntegration(): void {
    const integ = this.allIntegrations.find((i) => i.id === this.integrationId);
    if (!integ?.metadata?.tools) {
      this.availableTools = [];
      return;
    }

    const cfg = integ.config ?? {};
    const disabledTools = new Set(Array.isArray(cfg['disabledTools']) ? cfg['disabledTools'] as string[] : []);

    this.availableTools = (integ.metadata.tools as ToolInfo[])
      .filter((t) => !disabledTools.has(t.name));

    // If editing, re-populate param fields for current tool
    if (this.toolName) {
      const tool = this.availableTools.find((t) => t.name === this.toolName);
      if (tool?.inputSchema) {
        const props = (tool.inputSchema['properties'] ?? {}) as Record<string, { type?: string; description?: string }>;
        this.toolParamFields = Object.entries(props).map(([key, schema]) => ({
          name: key,
          type: schema.type ?? 'string',
          description: schema.description ?? '',
        }));
      }
    }
  }
}

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;

  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour at :00';
  if (min === '0' && hour?.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') return `Every ${hour.slice(2)} hours`;
  if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow === '*') return `Daily at ${hour}:${min.padStart(2, '0')}`;
  if (min !== '*' && hour !== '*' && dom === '*' && mon === '*' && dow !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = days[Number(dow)] ?? dow;
    return `Every ${dayName} at ${hour}:${min.padStart(2, '0')}`;
  }
  return expr;
}

/**
 * Client-side UTC preview: compute what UTC time the local schedule maps to.
 * Uses the same Intl.DateTimeFormat approach as the server-side buildUtcCron.
 */
function computeUtcPreview(hour: number, minute: number, selectedDays: boolean[], timezone: string): string {
  try {
    // Create a date in the target timezone for today
    const now = new Date();
    const localStr = now.toLocaleDateString('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [month, day, year] = localStr.split('/').map(Number);
    // Build a date at the desired local time
    const target = new Date(Date.UTC(year, month - 1, day, hour, minute));

    // Get offset by comparing UTC formatted vs local formatted, including the date
    const utcParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(target);
    const localParts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(target);

    const getVal = (parts: Intl.DateTimeFormatPart[], type: string) => {
      const v = parts.find((p) => p.type === type)?.value ?? '0';
      return type === 'hour' && v === '24' ? 0 : Number(v);
    };

    const toUtcMillis = (parts: Intl.DateTimeFormatPart[]) =>
      Date.UTC(getVal(parts, 'year'), getVal(parts, 'month') - 1, getVal(parts, 'day'), getVal(parts, 'hour'), getVal(parts, 'minute'));

    // Compute the offset (local - UTC) in minutes using full date/time
    const offsetMinutes = Math.round((toUtcMillis(localParts) - toUtcMillis(utcParts)) / 60000);
    let resultMinutes = (hour * 60 + minute) - offsetMinutes;
    if (resultMinutes < 0) resultMinutes += 24 * 60;
    if (resultMinutes >= 24 * 60) resultMinutes -= 24 * 60;

    // Track day shift using the same carry logic as buildUtcCron
    let utcMinute = minute - (offsetMinutes % 60);
    let utcHour = hour - Math.trunc(offsetMinutes / 60);
    if (utcMinute < 0) { utcMinute += 60; utcHour -= 1; }
    else if (utcMinute >= 60) { utcMinute -= 60; utcHour += 1; }
    let dayShift = 0;
    if (utcHour < 0) { dayShift = -1; }
    else if (utcHour >= 24) { dayShift = 1; }

    const rH = Math.floor(resultMinutes / 60);
    const rM = resultMinutes % 60;

    // Build days string, applying dayShift to selected days
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const anySelected = selectedDays.some(Boolean);
    let displayDays = selectedDays.map((c, i) => c ? i : -1).filter((i) => i >= 0);
    if (dayShift !== 0) {
      displayDays = displayDays.map((d) => ((d + dayShift) % 7 + 7) % 7);
      displayDays.sort((a, b) => a - b);
    }
    const daysText = !anySelected || selectedDays.every(Boolean)
      ? 'Daily'
      : displayDays.map((d) => dayNames[d]).join(', ');

    return `${daysText} at ${rH.toString().padStart(2, '0')}:${rM.toString().padStart(2, '0')}`;
  } catch {
    return 'Unable to compute';
  }
}
