import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent } from '../../shared/components/index.js';
import { ScheduledProbeService, ScheduledProbe, CreateProbeRequest, UpdateProbeRequest } from '../../core/services/scheduled-probe.service';
import { IntegrationService, ClientIntegration } from '../../core/services/integration.service';
import { Client } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';

interface ToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
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
  selector: 'app-probe-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent],
  template: `
    <div class="dialog-content">
      <div class="form-grid">
        <app-form-field label="Name">
          <app-text-input [value]="name" (valueChange)="name = $event" placeholder="e.g. Daily Blocking Check"></app-text-input>
        </app-form-field>

        <app-form-field label="Description">
          <app-textarea [value]="description" (valueChange)="description = $event" placeholder="Optional description"></app-textarea>
        </app-form-field>

        @if (!isEdit) {
          <app-form-field label="Client">
            <app-select [value]="clientId" [options]="clientSelectOptions" (valueChange)="clientId = $event; onClientChange()"></app-select>
          </app-form-field>

          <app-form-field label="Tool Source">
            <app-select [value]="toolSource" [options]="toolSourceOptions" (valueChange)="toolSource = $event === 'builtin' ? 'builtin' : 'mcp'; onToolSourceChange()"></app-select>
          </app-form-field>

          @if (toolSource === 'mcp') {
            <app-form-field label="Integration">
              <app-select [value]="integrationId" [options]="integrationSelectOptions" [disabled]="!clientId" (valueChange)="integrationId = $event; onIntegrationChange()"></app-select>
            </app-form-field>
          }
        }

        <app-form-field label="Tool">
          <app-select [value]="toolName" [options]="toolSelectOptions" [disabled]="toolSource === 'mcp' ? !integrationId : false" (valueChange)="toolName = $event; onToolChange()"></app-select>
        </app-form-field>

        @if (toolParamFields.length > 0) {
          <div class="params-section">
            <h4>Tool Parameters</h4>
            @for (field of toolParamFields; track field.name) {
              <app-form-field [label]="field.name" [hint]="field.description">
                <app-text-input [value]="getToolParam(field.name)" [type]="field.type === 'number' ? 'number' : 'text'" [placeholder]="field.description" (valueChange)="setToolParam(field.name, $event, field.type)"></app-text-input>
              </app-form-field>
            }
          </div>
        }

        <app-form-field label="Schedule Type">
          <app-select [value]="scheduleType" [options]="scheduleTypeOptions" (valueChange)="scheduleType = $event === 'cron' ? 'cron' : 'time'; onScheduleTypeChange()"></app-select>
        </app-form-field>

        @if (scheduleType === 'time') {
          <div class="time-row">
            <app-form-field label="Hour">
              <app-select [value]="scheduleHour.toString()" [options]="hourSelectOptions" (valueChange)="scheduleHour = +$event"></app-select>
            </app-form-field>
            <app-form-field label="Minute">
              <app-select [value]="scheduleMinute.toString()" [options]="minuteSelectOptions" (valueChange)="scheduleMinute = +$event"></app-select>
            </app-form-field>
          </div>

          <div class="days-section">
            <label class="days-label">Days</label>
            <div class="days-row">
              @for (day of dayNames; track $index) {
                <label class="checkbox-item">
                  <input type="checkbox" class="form-checkbox" [(ngModel)]="selectedDays[$index]">
                  {{ day }}
                </label>
              }
            </div>
            <span class="days-hint">Leave all unchecked for every day</span>
          </div>

          <app-form-field label="Timezone">
            <app-select [value]="scheduleTimezone" [options]="commonTimezones" (valueChange)="scheduleTimezone = $event"></app-select>
          </app-form-field>

          <div class="utc-hint">Next run: {{ computedUtcTime }} UTC</div>
        }

        @if (scheduleType === 'cron') {
          <app-form-field label="Schedule Preset">
            <app-select [value]="cronPreset" [options]="cronPresets" placeholder="" (valueChange)="cronPreset = $event; onPresetChange()"></app-select>
          </app-form-field>

          <app-form-field label="Cron Expression" [hint]="cronHumanReadable">
            <app-text-input [value]="cronExpression" (valueChange)="cronExpression = $event" placeholder="0 * * * *"></app-text-input>
          </app-form-field>
        }

        <app-form-field label="Action">
          <app-select [value]="action" [options]="actions" (valueChange)="action = $event"></app-select>
        </app-form-field>

        @if (action === 'create_ticket' || action === 'silent') {
          <app-form-field label="Operator Email" hint="Operator who will receive ticket updates and findings">
            <app-text-input [value]="operatorEmail" (valueChange)="operatorEmail = $event" type="email" placeholder="operator@example.com"></app-text-input>
          </app-form-field>
        }

        @if (action === 'email_direct') {
          <app-form-field label="Email To">
            <app-text-input [value]="emailTo" (valueChange)="emailTo = $event" type="email" placeholder="recipient@example.com"></app-text-input>
          </app-form-field>
          <app-form-field label="Email Subject">
            <app-text-input [value]="emailSubject" (valueChange)="emailSubject = $event" placeholder="Optional custom subject"></app-text-input>
          </app-form-field>
        }

        @if (action !== 'email_direct') {
          <app-form-field label="Category" hint="Category assigned to tickets created by this probe.">
            <app-select [value]="category ?? ''" [options]="categorySelectOptions" placeholder="" (valueChange)="category = $event || null"></app-select>
          </app-form-field>
        }

        @if (isEdit) {
          <div class="retention-section">
            <h4>Retention Settings</h4>
            <div class="retention-row">
              <div class="retention-field">
                <app-form-field label="Retention Days">
                  <app-text-input type="number" [value]="retentionDays.toString()" (valueChange)="retentionDays = +$event"></app-text-input>
                </app-form-field>
              </div>
              <div class="retention-field">
                <app-form-field label="Max Runs">
                  <app-text-input type="number" [value]="retentionMaxRuns.toString()" (valueChange)="retentionMaxRuns = +$event"></app-text-input>
                </app-form-field>
              </div>
            </div>
          </div>
        }
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" (click)="save()" [disabled]="!canSave() || saving">
        {{ saving ? 'Saving...' : (isEdit ? 'Update' : 'Create') }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .dialog-content { min-width: 450px; }
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .params-section { margin-bottom: 8px; }
    .params-section h4 { margin: 0 0 8px; font-size: 14px; color: var(--text-tertiary); }
    .time-row { display: flex; gap: 12px; }
    .time-row app-form-field { flex: 1; }
    .days-section { margin-bottom: 16px; }
    .days-label { font-size: 12px; color: var(--text-tertiary); display: block; margin-bottom: 4px; }
    .days-row { display: flex; gap: 4px; flex-wrap: wrap; }
    .days-hint { font-size: 11px; color: var(--text-tertiary); display: block; margin-top: 2px; }
    .utc-hint { font-size: 12px; color: var(--color-info); margin-bottom: 12px; padding: 4px 8px; background: var(--color-info-subtle); border-radius: 4px; }
    .retention-section { margin-top: 8px; }
    .retention-section h4 { margin: 0 0 8px; font-size: 14px; color: var(--text-tertiary); }
    .retention-row { display: flex; gap: 12px; }
    .retention-field { flex: 1; }
    .retention-field app-form-field { flex: 1; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .checkbox-item { display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; }
    .form-checkbox { width: 15px; height: 15px; cursor: pointer; accent-color: var(--accent); }
  `],
})
export class ProbeDialogComponent implements OnInit {
  private probeService = inject(ScheduledProbeService);
  private integrationService = inject(IntegrationService);
  private toast = inject(ToastService);

  probe = input<ScheduledProbe>();
  clients = input.required<Client[]>();
  categories = input.required<ReadonlyArray<{ readonly value: string; readonly label: string }>>();

  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;
  name = '';
  description = '';
  clientId = '';
  integrationId = '';
  toolName = '';
  toolParams: Record<string, unknown> = {};
  cronExpression = '0 * * * *';
  cronPreset = '';
  category: string | null = null;
  action = 'create_ticket';
  operatorEmail = '';
  emailTo = '';
  emailSubject = '';
  retentionDays = 30;
  retentionMaxRuns = 100;
  saving = false;

  scheduleType: 'time' | 'cron' = 'time';
  scheduleHour = 8;
  scheduleMinute = 0;
  scheduleTimezone = 'America/Chicago';
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

  clientsList: Client[] = [];
  categoriesList: ReadonlyArray<{ readonly value: string; readonly label: string }> = [];

  toolSourceOptions = [
    { value: 'mcp', label: 'MCP Integration' },
    { value: 'builtin', label: 'Built-in' },
  ];

  scheduleTypeOptions = [
    { value: 'time', label: 'Time-based (recommended)' },
    { value: 'cron', label: 'Custom cron' },
  ];

  get clientSelectOptions() {
    return this.clientsList.map((c) => ({ value: c.id, label: c.name + ' (' + c.shortCode + ')' }));
  }

  get integrationSelectOptions() {
    return this.filteredIntegrations.map((i) => ({ value: i.id, label: i.label + ' (' + i.type + ')' }));
  }

  get toolSelectOptions() {
    return this.availableTools.map((t) => ({ value: t.name, label: t.name + ' — ' + t.description }));
  }

  get hourSelectOptions() {
    return this.hourOptions.map((h) => ({ value: h.value.toString(), label: h.label }));
  }

  get minuteSelectOptions() {
    return this.minuteOptions.map((m) => ({ value: m.value.toString(), label: m.label }));
  }

  get categorySelectOptions() {
    return [{ value: '', label: 'None' }, ...this.categoriesList.map((c) => ({ value: c.value, label: c.label }))];
  }

  get cronHumanReadable(): string {
    return describeCron(this.cronExpression);
  }

  get computedUtcTime(): string {
    return computeUtcPreview(this.scheduleHour, this.scheduleMinute, this.selectedDays, this.scheduleTimezone);
  }

  getToolParam(name: string): string {
    return String(this.toolParams[name] ?? '');
  }

  setToolParam(name: string, val: string, type: string): void {
    this.toolParams = { ...this.toolParams, [name]: type === 'number' ? +val : val };
  }

  ngOnInit(): void {
    this.clientsList = this.clients();
    this.categoriesList = this.categories();

    const p = this.probe();
    this.isEdit = !!p;

    if (p) {
      this.name = p.name ?? '';
      this.description = p.description ?? '';
      this.clientId = p.clientId ?? '';
      this.integrationId = p.integrationId ?? '';
      this.toolName = p.toolName ?? '';
      this.toolParams = { ...(p.toolParams ?? {}) };
      this.cronExpression = p.cronExpression ?? '0 * * * *';
      this.category = p.category ?? null;
      this.action = p.action ?? 'create_ticket';
      this.retentionDays = p.retentionDays ?? 30;
      this.retentionMaxRuns = p.retentionMaxRuns ?? 100;
      this.scheduleType = p.scheduleTimezone ? 'time' : 'cron';
      this.scheduleHour = p.scheduleHour ?? 8;
      this.scheduleMinute = p.scheduleMinute ?? 0;
      this.scheduleTimezone = p.scheduleTimezone ?? 'America/Chicago';

      // Load action config
      if (p.actionConfig) {
        const cfg = p.actionConfig;
        this.operatorEmail = typeof cfg['operatorEmail'] === 'string' ? cfg['operatorEmail'] : '';
        this.emailTo = typeof cfg['emailTo'] === 'string' ? cfg['emailTo'] : '';
        this.emailSubject = typeof cfg['emailSubject'] === 'string' ? cfg['emailSubject'] : '';
      }

      // Populate days of week
      if (p.scheduleDaysOfWeek) {
        const days = p.scheduleDaysOfWeek.split(',').map(Number);
        for (const d of days) {
          if (d >= 0 && d <= 6) this.selectedDays[d] = true;
        }
      }
    }

    // Set cron preset if it matches
    const match = CRON_PRESETS.find((pr) => pr.value === this.cronExpression);
    this.cronPreset = match ? match.value : '';

    // Load built-in tools
    this.probeService.getBuiltinTools().subscribe((tools) => {
      this.builtinTools = tools;
      if (this.isEdit && this.toolName && tools.some((t) => t.name === this.toolName)) {
        this.toolSource = 'builtin';
        this.availableTools = this.builtinTools;
        const existingParams = this.toolParams;
        this.onToolChange();
        if (existingParams) this.toolParams = existingParams;
      } else if (this.toolSource === 'builtin') {
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
      this.probeService.updateProbe(this.probe()!.id, updateData).subscribe({
        next: () => {
          this.toast.success('Probe updated');
          this.saved.emit(true);
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
          this.saved.emit(true);
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

function computeUtcPreview(hour: number, minute: number, selectedDays: boolean[], timezone: string): string {
  try {
    const now = new Date();
    const localStr = now.toLocaleDateString('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [month, day, year] = localStr.split('/').map(Number);
    const target = new Date(Date.UTC(year, month - 1, day, hour, minute));

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

    const offsetMinutes = Math.round((toUtcMillis(localParts) - toUtcMillis(utcParts)) / 60000);
    let resultMinutes = (hour * 60 + minute) - offsetMinutes;
    if (resultMinutes < 0) resultMinutes += 24 * 60;
    if (resultMinutes >= 24 * 60) resultMinutes -= 24 * 60;

    let utcMinute = minute - (offsetMinutes % 60);
    let utcHour = hour - Math.trunc(offsetMinutes / 60);
    if (utcMinute < 0) { utcMinute += 60; utcHour -= 1; }
    else if (utcMinute >= 60) { utcMinute -= 60; utcHour += 1; }
    let dayShift = 0;
    if (utcHour < 0) { dayShift = -1; }
    else if (utcHour >= 24) { dayShift = 1; }

    const rH = Math.floor(resultMinutes / 60);
    const rM = resultMinutes % 60;

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
