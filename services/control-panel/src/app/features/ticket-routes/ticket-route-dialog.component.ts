import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TicketRouteService, TicketRoute } from '../../core/services/ticket-route.service';
import type { RouteType } from '../../core/services/ticket-route.service';
import { Client } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent } from '../../shared/components/index.js';

const SOURCES = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'MANUAL', label: 'Manual' },
  { value: 'AZURE_DEVOPS', label: 'Azure DevOps' },
  { value: 'SCHEDULED', label: 'Scheduled (Probes)' },
  { value: 'AI_DETECTED', label: 'AI Detected' },
];

@Component({
  selector: 'app-ticket-route-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, ToggleSwitchComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input
          [value]="name"
          placeholder="e.g. Database Performance Pipeline"
          (valueChange)="name = $event" />
      </app-form-field>

      <app-form-field label="Description">
        <app-textarea
          [value]="description"
          [rows]="2"
          placeholder="Optional description of this route"
          (valueChange)="description = $event" />
      </app-form-field>

      <app-form-field label="Route Type" hint="Ingestion routes enrich + create tickets from a source. Analysis routes investigate existing tickets.">
        <app-select
          [value]="routeType"
          [options]="routeTypeOptions"
          (valueChange)="routeType = $event === 'INGESTION' ? 'INGESTION' : 'ANALYSIS'" />
      </app-form-field>

      <app-form-field label="Source Filter" [hint]="routeType === 'INGESTION' ? 'Ingestion routes should target a specific source.' : 'Optionally restrict this route to tickets from a specific source.'">
        <app-select
          [value]="source ?? ''"
          [options]="sourceOptions"
          placeholder=""
          (valueChange)="source = $event || null" />
      </app-form-field>

      <app-form-field label="Category" hint="Routes with a category match tickets of that type. &quot;Any&quot; routes are selected by AI or used as default.">
        <app-select
          [value]="category ?? ''"
          [options]="categorySelectOptions"
          placeholder=""
          (valueChange)="category = $event || null" />
      </app-form-field>

      <app-form-field label="Client" hint="Client-specific routes take priority over global routes.">
        <app-select
          [value]="clientId ?? ''"
          [options]="clientSelectOptions"
          placeholder=""
          (valueChange)="clientId = $event || null" />
      </app-form-field>

      <app-form-field label="Sort Order" hint="Lower numbers are evaluated first.">
        <app-text-input
          [value]="sortOrder.toString()"
          type="number"
          (valueChange)="sortOrder = +$event" />
      </app-form-field>

      <div class="toggle-row">
        <app-toggle-switch
          [checked]="isDefault"
          label="Default route"
          (checkedChange)="isDefault = $event" />
        <span class="toggle-hint">Used when no category or AI-based match is found.</span>
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!name.trim() || saving" (click)="save()">
        {{ saving ? 'Saving...' : (isEdit ? 'Update' : 'Create') }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .toggle-row { display: flex; align-items: center; gap: 12px; }
    .toggle-hint { font-size: 12px; color: var(--text-tertiary, #666); }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class TicketRouteDialogComponent implements OnInit {
  private routeService = inject(TicketRouteService);
  private toast = inject(ToastService);

  route = input<TicketRoute>();
  clients = input.required<Client[]>();
  categories = input.required<Array<{ value: string; label: string }>>();
  presetRouteType = input<RouteType>();

  saved = output<boolean>();
  cancelled = output<void>();

  sources = SOURCES;

  routeTypeOptions = [
    { value: 'ANALYSIS', label: 'Analysis' },
    { value: 'INGESTION', label: 'Ingestion' },
  ];

  sourceOptions = [
    { value: '', label: 'Any Source' },
    ...SOURCES,
  ];

  isEdit = false;
  name = '';
  description = '';
  routeType: RouteType = 'ANALYSIS';
  source: string | null = null;
  category: string | null = null;
  clientId: string | null = null;
  isDefault = false;
  sortOrder = 0;
  saving = false;

  clientsList: Client[] = [];
  categoriesList: Array<{ value: string; label: string }> = [];

  get categorySelectOptions(): Array<{ value: string; label: string }> {
    return [{ value: '', label: 'Any (catch-all)' }, ...this.categoriesList];
  }

  get clientSelectOptions(): Array<{ value: string; label: string }> {
    return [
      { value: '', label: 'Global (all clients)' },
      ...this.clientsList.map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
    ];
  }

  ngOnInit(): void {
    this.clientsList = this.clients();
    this.categoriesList = this.categories();

    const r = this.route();
    if (r) {
      this.isEdit = true;
      this.name = r.name ?? '';
      this.description = r.description ?? '';
      this.routeType = r.routeType ?? 'ANALYSIS';
      this.source = r.source ?? null;
      this.category = r.category ?? null;
      this.clientId = r.clientId ?? null;
      this.isDefault = r.isDefault ?? false;
      this.sortOrder = r.sortOrder ?? 0;
    } else {
      this.routeType = this.presetRouteType() ?? 'ANALYSIS';
    }
  }

  save(): void {
    if (!this.name.trim()) return;
    this.saving = true;

    if (this.isEdit) {
      this.routeService.updateRoute(this.route()!.id, {
        name: this.name.trim(),
        description: this.description.trim() || undefined,
        routeType: this.routeType,
        category: this.category,
        source: this.source,
        clientId: this.clientId,
        isDefault: this.isDefault,
        sortOrder: this.sortOrder,
      }).subscribe({
        next: () => {
          this.toast.success('Route updated');
          this.saved.emit(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.message ?? 'Failed to update route');
        },
      });
    } else {
      this.routeService.createRoute({
        name: this.name.trim(),
        description: this.description.trim() || undefined,
        routeType: this.routeType,
        category: this.category ?? undefined,
        source: this.source,
        clientId: this.clientId ?? undefined,
        isDefault: this.isDefault,
        sortOrder: this.sortOrder,
      }).subscribe({
        next: (result) => {
          if (result.warnings?.length) {
            this.toast.warning(result.warnings[0]);
          } else {
            this.toast.success('Route created');
          }
          this.saved.emit(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.message ?? 'Failed to create route');
        },
      });
    }
  }
}
