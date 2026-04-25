import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent, CronSchedulerComponent } from '../../shared/components/index.js';
import type { CronSchedulerValue } from '../../shared/components/index.js';
import { ScheduledProbeService, ScheduledProbe, CreateProbeRequest, UpdateProbeRequest } from '../../core/services/scheduled-probe.service.js';
import { IntegrationService, ClientIntegration } from '../../core/services/integration.service.js';
import { Client } from '../../core/services/client.service.js';
import { ToastService } from '../../core/services/toast.service.js';

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

@Component({
  selector: 'app-probe-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent, CronSchedulerComponent],
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
            @for (field of toolParamFields; track $index) {
              <app-form-field [label]="field.name" [hint]="field.description">
                <app-text-input [value]="getToolParam(field.name)" [type]="field.type === 'number' ? 'number' : 'text'" [placeholder]="field.description" (valueChange)="setToolParam(field.name, $event, field.type)"></app-text-input>
              </app-form-field>
            }
          </div>
        }

        <app-cron-scheduler
          [initialScheduleType]="scheduleType"
          [initialHour]="scheduleHour"
          [initialMinute]="scheduleMinute"
          [initialDays]="selectedDays"
          [initialTimezone]="scheduleTimezone"
          [initialCronExpression]="cronExpression"
          (valueChange)="onScheduleChange($event)"
        />

        <app-form-field label="Action">
          <app-select [value]="action" [options]="actions" (valueChange)="action = $event"></app-select>
        </app-form-field>

        @if (action === 'create_ticket' || action === 'silent') {
          <app-form-field label="Operator Email" hint="Operator who will receive ticket updates and findings">
            <app-text-input [value]="operatorEmail" (valueChange)="operatorEmail = $event" type="email" placeholder="operator@example.com"></app-text-input>
          </app-form-field>
        }

        @if (action === 'create_ticket') {
          <app-form-field
            label="Ticket description body"
            hint="Optional. Used as the seed for tickets created by this probe. Haiku will fill in tool, timeframe, and result context automatically."
          >
            <app-textarea
              [value]="ticketDescription"
              (valueChange)="ticketDescription = $event"
              [rows]="5"
              placeholder="e.g. We've been seeing intermittent timeouts on the reporting service — pay attention to repeated tenants and time-of-day clustering."
            ></app-textarea>
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
            <app-select [value]="category ?? ''" [options]="categorySelectOptions" (valueChange)="category = $event || null"></app-select>
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
    .retention-section { margin-top: 8px; }
    .retention-section h4 { margin: 0 0 8px; font-size: 14px; color: var(--text-tertiary); }
    .retention-row { display: flex; gap: 12px; }
    .retention-field { flex: 1; }
    .retention-field app-form-field { flex: 1; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

    @media (max-width: 767.98px) {
      .dialog-content { min-width: 0; }
      .retention-row { flex-direction: column; gap: 12px; }
    }
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
  category: string | null = null;
  action = 'create_ticket';
  operatorEmail = '';
  ticketDescription = '';
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

  get clientSelectOptions() {
    return this.clientsList.map((c) => ({ value: c.id, label: c.name + ' (' + c.shortCode + ')' }));
  }

  get integrationSelectOptions() {
    return this.filteredIntegrations.map((i) => ({ value: i.id, label: i.label + ' (' + i.type + ')' }));
  }

  get toolSelectOptions() {
    return this.availableTools.map((t) => ({ value: t.name, label: t.name + ' — ' + t.description }));
  }

  get categorySelectOptions() {
    return [{ value: '', label: 'None' }, ...this.categoriesList.map((c) => ({ value: c.value, label: c.label }))];
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
        this.ticketDescription = typeof cfg['ticketDescription'] === 'string' ? cfg['ticketDescription'] : '';
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

  onScheduleChange(val: CronSchedulerValue): void {
    this.scheduleType = val.scheduleType;
    this.scheduleHour = val.scheduleHour;
    this.scheduleMinute = val.scheduleMinute;
    this.selectedDays = val.selectedDays;
    this.scheduleTimezone = val.scheduleTimezone;
    this.cronExpression = val.cronExpression;
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
      const cfg: Record<string, unknown> = {};
      if (this.operatorEmail) cfg['operatorEmail'] = this.operatorEmail;
      // Only persist `ticketDescription` for create_ticket — irrelevant for silent.
      if (this.action === 'create_ticket') {
        const trimmedBody = this.ticketDescription.trim();
        if (trimmedBody) cfg['ticketDescription'] = trimmedBody;
      }
      if (Object.keys(cfg).length > 0) actionConfig = cfg;
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

