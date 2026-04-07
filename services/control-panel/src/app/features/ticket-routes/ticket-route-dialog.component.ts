import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TicketRouteService, TicketRoute } from '../../core/services/ticket-route.service';
import type { RouteType } from '../../core/services/ticket-route.service';
import { Client } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';

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
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatSlideToggleModule],
  template: `
    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="name" required placeholder="e.g. Database Performance Pipeline">
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Description</mat-label>
      <textarea matInput [(ngModel)]="description" rows="2" placeholder="Optional description of this route"></textarea>
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Route Type</mat-label>
      <mat-select [(ngModel)]="routeType">
        <mat-option value="ANALYSIS">Analysis</mat-option>
        <mat-option value="INGESTION">Ingestion</mat-option>
      </mat-select>
      <mat-hint>Ingestion routes enrich + create tickets from a source. Analysis routes investigate existing tickets.</mat-hint>
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Source Filter</mat-label>
      <mat-select [(ngModel)]="source">
        <mat-option [value]="null">Any Source</mat-option>
        @for (s of sources; track s.value) {
          <mat-option [value]="s.value">{{ s.label }}</mat-option>
        }
      </mat-select>
      <mat-hint>{{ routeType === 'INGESTION' ? 'Ingestion routes should target a specific source.' : 'Optionally restrict this route to tickets from a specific source.' }}</mat-hint>
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Category</mat-label>
      <mat-select [(ngModel)]="category">
        <mat-option [value]="null">Any (catch-all)</mat-option>
        @for (cat of categoriesList; track cat.value) {
          <mat-option [value]="cat.value">{{ cat.label }}</mat-option>
        }
      </mat-select>
      <mat-hint>Routes with a category match tickets of that type. "Any" routes are selected by AI or used as default.</mat-hint>
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Client</mat-label>
      <mat-select [(ngModel)]="clientId">
        <mat-option [value]="null">Global (all clients)</mat-option>
        @for (c of clientsList; track c.id) {
          <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
        }
      </mat-select>
      <mat-hint>Client-specific routes take priority over global routes.</mat-hint>
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Sort Order</mat-label>
      <input matInput type="number" [(ngModel)]="sortOrder" min="0">
      <mat-hint>Lower numbers are evaluated first.</mat-hint>
    </mat-form-field>

    <div class="toggle-row">
      <mat-slide-toggle [(ngModel)]="isDefault" color="primary">Default route</mat-slide-toggle>
      <span class="toggle-hint">Used when no category or AI-based match is found.</span>
    </div>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name.trim() || saving">
        {{ saving ? 'Saving...' : (isEdit ? 'Update' : 'Create') }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .toggle-row { display: flex; align-items: center; gap: 12px; margin: 8px 0 16px; }
    .toggle-hint { font-size: 12px; color: #666; }
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
