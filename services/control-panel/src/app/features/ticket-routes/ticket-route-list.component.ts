import { Component, inject, OnInit, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
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
import { MatTabsModule } from '@angular/material/tabs';
import { TicketRouteService, TicketRoute, TicketRouteStep, RouteStepTypeInfo } from '../../core/services/ticket-route.service';
import type { RouteType } from '../../core/services/ticket-route.service';
import { ClientService, Client } from '../../core/services/client.service';
import { TicketRouteDialogComponent } from './ticket-route-dialog.component';
import { TicketRouteStepDialogComponent } from './ticket-route-step-dialog.component';

const CATEGORIES = [
  { value: 'DATABASE_PERF', label: 'Database Perf' },
  { value: 'BUG_FIX', label: 'Bug Fix' },
  { value: 'FEATURE_REQUEST', label: 'Feature Request' },
  { value: 'SCHEMA_CHANGE', label: 'Schema Change' },
  { value: 'CODE_REVIEW', label: 'Code Review' },
  { value: 'ARCHITECTURE', label: 'Architecture' },
  { value: 'GENERAL', label: 'General' },
];

@Component({
  standalone: true,
  imports: [
    NgTemplateOutlet,
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
    MatTabsModule,
  ],
  template: `
    <div class="page-header">
      <h1>Ticket Routes</h1>
    </div>

    <mat-tab-group (selectedTabChange)="onTabChange($event.index)">
      <!-- Ingestion Routes Tab -->
      <mat-tab label="Ingestion Routes">
        <div class="tab-content">
          <div class="tab-header">
            <p class="tab-desc">Ingestion routes enrich raw payloads (email, probe, DevOps) and create tickets. Matched by source type.</p>
            <button mat-raised-button color="primary" (click)="addRoute('INGESTION')">
              <mat-icon>add</mat-icon> Add Ingestion Route
            </button>
          </div>
          <ng-container *ngTemplateOutlet="routeList; context: { $implicit: ingestionRoutes() }"></ng-container>
        </div>
      </mat-tab>

      <!-- Analysis Routes Tab -->
      <mat-tab label="Analysis Routes">
        <div class="tab-content">
          <div class="tab-header">
            <p class="tab-desc">Analysis routes investigate existing tickets. Matched by category and client.</p>
            <button mat-raised-button color="primary" (click)="addRoute('ANALYSIS')">
              <mat-icon>add</mat-icon> Add Analysis Route
            </button>
          </div>
          <ng-container *ngTemplateOutlet="routeList; context: { $implicit: analysisRoutes() }"></ng-container>
        </div>
      </mat-tab>
    </mat-tab-group>

    <!-- Shared route card template -->
    <ng-template #routeList let-routes>
      <div class="filters">
        <mat-form-field appearance="outline" class="filter-field">
          <mat-label>Client</mat-label>
          <mat-select [(ngModel)]="filterClientId" (selectionChange)="loadRoutes()">
            <mat-option value="">All (Global + Client)</mat-option>
            <mat-option value="__global__">Global Only</mat-option>
            @for (c of clients(); track c.id) {
              <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>

      @if (routes.length === 0) {
        <mat-card class="empty-card">
          <p class="empty">No routes found. Create a route to define how tickets are processed.</p>
        </mat-card>
      } @else {
        @for (route of routes; track route.id) {
          <mat-card class="route-card">
            <div class="route-header">
              <div class="route-title-row">
                <h2>{{ route.name }}</h2>
                @if (route.isDefault) {
                  <span class="badge badge-default">Default</span>
                }
                @if (!route.isActive) {
                  <span class="badge badge-inactive">Inactive</span>
                }
                @if (route.source) {
                  <span class="badge badge-source">{{ route.source }}</span>
                }
                @if (route.category) {
                  <span class="badge badge-category">{{ categoryLabel(route.category) }}</span>
                } @else {
                  <span class="badge badge-any">Any Category</span>
                }
                @if (route.client) {
                  <span class="badge badge-client">{{ route.client.shortCode }}</span>
                } @else {
                  <span class="badge badge-global">Global</span>
                }
              </div>
              <div class="route-actions">
                <mat-slide-toggle
                  [checked]="route.isActive"
                  (change)="toggleActive(route)"
                  color="primary"
                  matTooltip="Toggle active">
                </mat-slide-toggle>
                <button mat-icon-button matTooltip="Regenerate AI summary" (click)="regenerateSummary(route)">
                  <mat-icon>auto_awesome</mat-icon>
                </button>
                <button mat-icon-button matTooltip="Edit route" (click)="editRoute(route)">
                  <mat-icon>edit</mat-icon>
                </button>
                <button mat-icon-button color="warn" matTooltip="Delete route" (click)="deleteRoute(route)">
                  <mat-icon>delete</mat-icon>
                </button>
              </div>
            </div>

            @if (route.description) {
              <p class="route-desc">{{ route.description }}</p>
            }
            @if (route.summary) {
              <p class="route-summary"><mat-icon class="inline-icon">auto_awesome</mat-icon> {{ route.summary }}</p>
            }

            <!-- Steps table -->
            <div class="steps-section">
              <div class="steps-header">
                <h3>Steps ({{ route.steps.length }})</h3>
                <button mat-stroked-button (click)="addStep(route)">
                  <mat-icon>add</mat-icon> Add Step
                </button>
              </div>

              @if (route.steps.length > 0) {
                <table mat-table [dataSource]="route.steps" class="full-width steps-table">
                  <ng-container matColumnDef="order">
                    <th mat-header-cell *matHeaderCellDef>#</th>
                    <td mat-cell *matCellDef="let s">{{ s.stepOrder }}</td>
                  </ng-container>

                  <ng-container matColumnDef="name">
                    <th mat-header-cell *matHeaderCellDef>Name</th>
                    <td mat-cell *matCellDef="let s">{{ s.name }}</td>
                  </ng-container>

                  <ng-container matColumnDef="stepType">
                    <th mat-header-cell *matHeaderCellDef>Step Type</th>
                    <td mat-cell *matCellDef="let s">
                      <span class="step-type-chip" [class]="'phase-' + stepPhase(s.stepType)">{{ s.stepType }}</span>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="overrides">
                    <th mat-header-cell *matHeaderCellDef>Overrides</th>
                    <td mat-cell *matCellDef="let s">
                      @if (s.taskTypeOverride) {
                        <span class="override-chip" matTooltip="Task type override">{{ s.taskTypeOverride }}</span>
                      }
                      @if (s.promptKeyOverride) {
                        <span class="override-chip prompt-override" matTooltip="Prompt key override">{{ s.promptKeyOverride }}</span>
                      }
                      @if (!s.taskTypeOverride && !s.promptKeyOverride) {
                        <span class="muted">—</span>
                      }
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="active">
                    <th mat-header-cell *matHeaderCellDef>Active</th>
                    <td mat-cell *matCellDef="let s">
                      <mat-slide-toggle
                        [checked]="s.isActive"
                        (change)="toggleStepActive(route, s)"
                        color="primary">
                      </mat-slide-toggle>
                    </td>
                  </ng-container>

                  <ng-container matColumnDef="actions">
                    <th mat-header-cell *matHeaderCellDef></th>
                    <td mat-cell *matCellDef="let s">
                      <button mat-icon-button matTooltip="Edit step" (click)="editStep(route, s)">
                        <mat-icon>edit</mat-icon>
                      </button>
                      <button mat-icon-button color="warn" matTooltip="Delete step" (click)="deleteStep(route, s)">
                        <mat-icon>delete</mat-icon>
                      </button>
                    </td>
                  </ng-container>

                  <tr mat-header-row *matHeaderRowDef="stepColumns"></tr>
                  <tr mat-row *matRowDef="let row; columns: stepColumns;"></tr>
                </table>
              } @else {
                <p class="empty-steps">No steps defined. Add steps to build the processing pipeline.</p>
              }
            </div>
          </mat-card>
        }
      }
    </ng-template>
  `,
  styles: [`
    .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .page-header h1 { margin: 0; }
    .tab-content { padding: 16px 0; }
    .tab-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; gap: 16px; }
    .tab-desc { margin: 0; color: #666; font-size: 14px; }
    .filters { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
    .filter-field { min-width: 200px; }
    .route-card { margin-bottom: 16px; padding: 20px; }
    .route-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    .route-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .route-title-row h2 { margin: 0; font-size: 18px; font-weight: 500; }
    .route-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .route-desc { margin: 8px 0 4px; color: #555; font-size: 14px; }
    .route-summary { margin: 4px 0 0; color: #666; font-size: 13px; font-style: italic; display: flex; align-items: flex-start; gap: 4px; }
    .inline-icon { font-size: 16px; width: 16px; height: 16px; color: #9c27b0; flex-shrink: 0; margin-top: 2px; }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
    .badge-default { background: #e8f5e9; color: #2e7d32; }
    .badge-inactive { background: #fafafa; color: #999; border: 1px solid #e0e0e0; }
    .badge-category { background: #e8eaf6; color: #3f51b5; }
    .badge-any { background: #f5f5f5; color: #777; }
    .badge-client { background: #fff3e0; color: #e65100; }
    .badge-global { background: #e3f2fd; color: #1565c0; }
    .badge-source { background: #fce4ec; color: #c62828; }
    .steps-section { margin-top: 16px; }
    .steps-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .steps-header h3 { margin: 0; font-size: 15px; font-weight: 500; color: #555; }
    .steps-table { width: 100%; }
    .step-type-chip { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; font-family: monospace; }
    .phase-ingestion { background: #fff3e0; color: #e65100; }
    .phase-analysis { background: #e8eaf6; color: #3f51b5; }
    .phase-dispatch { background: #f3e5f5; color: #7b1fa2; }
    .override-chip { font-size: 11px; padding: 2px 6px; border-radius: 3px; background: #fce4ec; color: #c62828; margin-right: 4px; font-family: monospace; display: inline-block; margin-bottom: 2px; }
    .prompt-override { background: #f3e5f5; color: #7b1fa2; }
    .muted { color: #999; }
    .empty { color: #999; text-align: center; padding: 24px 16px; margin: 0; }
    .empty-card { margin-bottom: 16px; }
    .empty-steps { color: #999; text-align: center; padding: 12px; margin: 0; font-size: 13px; }
    .full-width { width: 100%; }
  `],
})
export class TicketRouteListComponent implements OnInit {
  private routeService = inject(TicketRouteService);
  private clientService = inject(ClientService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  routes = signal<TicketRoute[]>([]);
  ingestionRoutes = signal<TicketRoute[]>([]);
  analysisRoutes = signal<TicketRoute[]>([]);
  clients = signal<Client[]>([]);
  stepTypes = signal<RouteStepTypeInfo[]>([]);

  categories = CATEGORIES;
  filterClientId = '';
  activeTab: RouteType = 'INGESTION';

  stepColumns = ['order', 'name', 'stepType', 'overrides', 'active', 'actions'];

  private stepTypeMap = new Map<string, RouteStepTypeInfo>();

  ngOnInit(): void {
    this.clientService.getClients().subscribe((c) => this.clients.set(c));
    this.routeService.getStepTypes().subscribe((types) => {
      this.stepTypes.set(types);
      this.stepTypeMap.clear();
      for (const t of types) this.stepTypeMap.set(t.type, t);
    });
    this.loadRoutes();
  }

  onTabChange(index: number): void {
    this.activeTab = index === 0 ? 'INGESTION' : 'ANALYSIS';
  }

  loadRoutes(): void {
    const filters: Record<string, string> = {};
    if (this.filterClientId === '__global__') {
      // Filter client-side below
    } else if (this.filterClientId) {
      filters['clientId'] = this.filterClientId;
    }
    this.routeService.getRoutes(filters).subscribe((routes) => {
      let filtered = routes;
      if (this.filterClientId === '__global__') {
        filtered = routes.filter((r) => !r.clientId);
      }
      this.routes.set(filtered);
      this.ingestionRoutes.set(filtered.filter((r) => r.routeType === 'INGESTION'));
      this.analysisRoutes.set(filtered.filter((r) => r.routeType === 'ANALYSIS'));
    });
  }

  categoryLabel(cat: string): string {
    return CATEGORIES.find((c) => c.value === cat)?.label ?? cat;
  }

  stepPhase(stepType: string): string {
    return this.stepTypeMap.get(stepType)?.phase ?? 'analysis';
  }

  addRoute(routeType: RouteType = 'ANALYSIS'): void {
    const ref = this.dialog.open(TicketRouteDialogComponent, {
      width: '550px',
      data: { clients: this.clients(), categories: CATEGORIES, routeType },
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.loadRoutes();
    });
  }

  editRoute(route: TicketRoute): void {
    const ref = this.dialog.open(TicketRouteDialogComponent, {
      width: '550px',
      data: { route, clients: this.clients(), categories: CATEGORIES },
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.loadRoutes();
    });
  }

  toggleActive(route: TicketRoute): void {
    this.routeService.updateRoute(route.id, { isActive: !route.isActive }).subscribe({
      next: () => {
        this.snackBar.open(`Route ${route.isActive ? 'deactivated' : 'activated'}`, 'OK', { duration: 3000 });
        this.loadRoutes();
      },
      error: () => this.snackBar.open('Failed to update route', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  regenerateSummary(route: TicketRoute): void {
    this.snackBar.open('Generating summary...', '', { duration: 10000 });
    this.routeService.regenerateSummary(route.id).subscribe({
      next: () => {
        this.snackBar.open('Summary updated', 'OK', { duration: 3000 });
        this.loadRoutes();
      },
      error: () => this.snackBar.open('Failed to generate summary', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  deleteRoute(route: TicketRoute): void {
    if (!confirm(`Delete route "${route.name}"? This will also delete all its steps.`)) return;
    this.routeService.deleteRoute(route.id).subscribe({
      next: () => {
        this.snackBar.open('Route deleted', 'OK', { duration: 3000 });
        this.loadRoutes();
      },
      error: () => this.snackBar.open('Failed to delete route', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  addStep(route: TicketRoute): void {
    const nextOrder = route.steps.length > 0
      ? Math.max(...route.steps.map((s) => s.stepOrder)) + 1
      : 1;
    const ref = this.dialog.open(TicketRouteStepDialogComponent, {
      width: '550px',
      data: { routeId: route.id, stepTypes: this.stepTypes(), nextOrder },
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.loadRoutes();
    });
  }

  editStep(route: TicketRoute, step: TicketRouteStep): void {
    const ref = this.dialog.open(TicketRouteStepDialogComponent, {
      width: '550px',
      data: { routeId: route.id, step, stepTypes: this.stepTypes() },
    });
    ref.afterClosed().subscribe((result) => {
      if (result) this.loadRoutes();
    });
  }

  toggleStepActive(route: TicketRoute, step: TicketRouteStep): void {
    this.routeService.updateStep(route.id, step.id, { isActive: !step.isActive }).subscribe({
      next: () => {
        this.snackBar.open(`Step ${step.isActive ? 'deactivated' : 'activated'}`, 'OK', { duration: 3000 });
        this.loadRoutes();
      },
      error: () => this.snackBar.open('Failed to update step', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }

  deleteStep(route: TicketRoute, step: TicketRouteStep): void {
    if (!confirm(`Delete step "${step.name}"?`)) return;
    this.routeService.deleteStep(route.id, step.id).subscribe({
      next: () => {
        this.snackBar.open('Step deleted', 'OK', { duration: 3000 });
        this.loadRoutes();
      },
      error: () => this.snackBar.open('Failed to delete step', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
}
