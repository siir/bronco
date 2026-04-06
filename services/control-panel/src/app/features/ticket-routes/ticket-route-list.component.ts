import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TicketRouteService, TicketRoute, TicketRouteStep, RouteStepTypeInfo } from '../../core/services/ticket-route.service';
import type { RouteType } from '../../core/services/ticket-route.service';
import { ClientService, Client } from '../../core/services/client.service';
import { TicketRouteDialogComponent } from './ticket-route-dialog.component';
import { TicketRouteStepDialogComponent } from './ticket-route-step-dialog.component';
import {
  BroncoButtonComponent,
  SelectComponent,
  TabComponent,
  TabGroupComponent,
  ToggleSwitchComponent,
} from '../../shared/components/index.js';

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
    MatDialogModule,
    BroncoButtonComponent,
    SelectComponent,
    TabComponent,
    TabGroupComponent,
    ToggleSwitchComponent,
  ],
  template: `
    <div class="page-wrapper">
      <div class="page-header">
        <h1>Ticket Routes</h1>
      </div>

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">

        <!-- Ingestion Routes Tab -->
        <app-tab label="Ingestion Routes">
          <div class="tab-content">
            <div class="tab-header">
              <p class="tab-desc">Ingestion routes enrich raw payloads (email, probe, DevOps) and create tickets. Matched by source type.</p>
              <app-bronco-button variant="primary" (click)="addRoute('INGESTION')">
                + Add Ingestion Route
              </app-bronco-button>
            </div>
            <ng-container *ngTemplateOutlet="routeList; context: { $implicit: ingestionRoutes() }"></ng-container>
          </div>
        </app-tab>

        <!-- Analysis Routes Tab -->
        <app-tab label="Analysis Routes">
          <div class="tab-content">
            <div class="tab-header">
              <p class="tab-desc">Analysis routes investigate existing tickets. Matched by category and client.</p>
              <app-bronco-button variant="primary" (click)="addRoute('ANALYSIS')">
                + Add Analysis Route
              </app-bronco-button>
            </div>
            <ng-container *ngTemplateOutlet="routeList; context: { $implicit: analysisRoutes() }"></ng-container>
          </div>
        </app-tab>

      </app-tab-group>

      <!-- Shared route card template -->
      <ng-template #routeList let-routes>
        <div class="filters">
          <app-select
            [value]="filterClientId"
            [options]="clientFilterOptions()"
            placeholder=""
            (valueChange)="filterClientId = $event; loadRoutes()">
          </app-select>
        </div>

        @if (routes.length === 0) {
          <div class="empty-card">
            <p class="empty">No routes found. Create a route to define how tickets are processed.</p>
          </div>
        } @else {
          @for (route of routes; track route.id) {
            <div class="route-card">
              <div class="route-header">
                <div class="route-title-row">
                  <h2 class="route-name">{{ route.name }}</h2>
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
                  <app-toggle-switch
                    [checked]="route.isActive"
                    (checkedChange)="toggleActive(route)">
                  </app-toggle-switch>
                  <app-bronco-button variant="ghost" size="sm" title="Regenerate AI summary" (click)="regenerateSummary(route)">✦</app-bronco-button>
                  <app-bronco-button variant="ghost" size="sm" title="Edit route" (click)="editRoute(route)">Edit</app-bronco-button>
                  <app-bronco-button variant="ghost" size="sm" title="Delete route" (click)="deleteRoute(route)">
                    <span class="destructive-text">Delete</span>
                  </app-bronco-button>
                </div>
              </div>

              @if (route.description) {
                <p class="route-desc">{{ route.description }}</p>
              }
              @if (route.summary) {
                <p class="route-summary"><span class="summary-icon">✦</span> {{ route.summary }}</p>
              }

              <!-- Steps table -->
              <div class="steps-section">
                <div class="steps-header">
                  <h3>Steps ({{ route.steps.length }})</h3>
                  <app-bronco-button variant="secondary" size="sm" (click)="addStep(route)">
                    + Add Step
                  </app-bronco-button>
                </div>

                @if (route.steps.length > 0) {
                  <table class="steps-table">
                    <thead>
                      <tr>
                        <th class="col-order">#</th>
                        <th>Name</th>
                        <th>Step Type</th>
                        <th>Overrides</th>
                        <th class="col-active">Active</th>
                        <th class="col-actions"></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (s of route.steps; track s.id) {
                        <tr>
                          <td class="col-order">{{ s.stepOrder }}</td>
                          <td>{{ s.name }}</td>
                          <td>
                            <span class="step-type-chip" [class]="'phase-' + stepPhase(s.stepType)">{{ s.stepType }}</span>
                          </td>
                          <td>
                            @if (s.taskTypeOverride) {
                              <span class="override-chip" title="Task type override">{{ s.taskTypeOverride }}</span>
                            }
                            @if (s.promptKeyOverride) {
                              <span class="override-chip prompt-override" title="Prompt key override">{{ s.promptKeyOverride }}</span>
                            }
                            @if (!s.taskTypeOverride && !s.promptKeyOverride) {
                              <span class="muted">—</span>
                            }
                          </td>
                          <td class="col-active">
                            <app-toggle-switch
                              [checked]="s.isActive"
                              (checkedChange)="toggleStepActive(route, s)">
                            </app-toggle-switch>
                          </td>
                          <td class="col-actions">
                            <div class="step-actions">
                              <app-bronco-button variant="ghost" size="sm" title="Edit step" (click)="editStep(route, s)">Edit</app-bronco-button>
                              <app-bronco-button variant="ghost" size="sm" title="Delete step" (click)="deleteStep(route, s)">
                                <span class="destructive-text">Delete</span>
                              </app-bronco-button>
                            </div>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <p class="empty-steps">No steps defined. Add steps to build the processing pipeline.</p>
                }
              </div>
            </div>
          }
        }
      </ng-template>
    </div>
  `,
  styles: [`
    .page-wrapper { max-width: 1200px; }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .page-header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 600;
      font-family: var(--font-primary);
      color: var(--text-primary);
      letter-spacing: -0.28px;
      line-height: 1.14;
    }

    .tab-content { padding: 0; }

    .tab-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      gap: 16px;
    }
    .tab-desc {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-tertiary);
    }

    .filters {
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    /* ── Route cards ── */
    .route-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      margin-bottom: 16px;
      overflow: hidden;
      padding: 20px;
    }

    .route-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .route-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .route-name {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .route-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .route-desc {
      margin: 8px 0 4px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-secondary);
    }
    .route-summary {
      margin: 4px 0 0;
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-tertiary);
      font-style: italic;
      display: flex;
      align-items: flex-start;
      gap: 4px;
    }
    .summary-icon {
      color: #6a1b9a;
      flex-shrink: 0;
      font-style: normal;
      margin-top: 1px;
    }
    .destructive-text { color: var(--color-error); }

    /* ── Badges ── */
    .badge {
      display: inline-block;
      font-family: var(--font-primary);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      white-space: nowrap;
    }
    .badge-default { background: rgba(52, 199, 89, 0.08); color: var(--color-success); }
    .badge-inactive { background: var(--bg-muted); color: var(--text-tertiary); border: 1px solid var(--border-light); }
    .badge-category { background: var(--bg-active); color: var(--accent); }
    .badge-any { background: var(--bg-muted); color: var(--text-tertiary); }
    .badge-client { background: rgba(255, 149, 0, 0.08); color: var(--color-warning); }
    .badge-global { background: rgba(0, 113, 227, 0.08); color: var(--accent); }
    .badge-source { background: rgba(255, 59, 48, 0.08); color: var(--color-error); }

    /* ── Steps table ── */
    .steps-section { margin-top: 16px; }
    .steps-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .steps-header h3 {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .steps-table {
      width: 100%;
      border-collapse: collapse;
    }
    .steps-table thead th {
      text-align: left;
      padding: 8px 16px;
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 500;
      color: var(--text-tertiary);
      border-bottom: 1px solid var(--border-light);
      user-select: none;
    }
    .steps-table tbody td {
      padding: 10px 16px;
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-light);
    }
    .steps-table tbody tr:last-child td { border-bottom: none; }
    .col-order { width: 40px; }
    .col-active { width: 64px; }
    .col-actions { width: 120px; }
    .step-actions {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    /* ── Step type chips ── */
    .step-type-chip {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: monospace;
    }
    .phase-ingestion { background: rgba(0, 122, 255, 0.08); color: var(--color-info); }
    .phase-analysis { background: rgba(52, 199, 89, 0.08); color: var(--color-success); }
    .phase-dispatch { background: rgba(106, 27, 154, 0.08); color: #6a1b9a; }
    .phase-context { background: rgba(255, 149, 0, 0.08); color: var(--color-warning); }

    /* ── Override chips ── */
    .override-chip {
      display: inline-block;
      font-size: 10px;
      font-weight: 500;
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      background: rgba(255, 149, 0, 0.08);
      color: var(--color-warning);
      font-family: monospace;
      margin-right: 4px;
      margin-bottom: 2px;
    }
    .prompt-override {
      background: rgba(106, 27, 154, 0.08);
      color: #6a1b9a;
    }

    /* ── Empty states ── */
    .muted { color: var(--text-tertiary); }
    .empty {
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-tertiary);
      text-align: center;
      padding: 24px 16px;
      margin: 0;
    }
    .empty-card {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-card);
      margin-bottom: 16px;
    }
    .empty-steps {
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-tertiary);
      text-align: center;
      padding: 12px;
      margin: 0;
    }
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
  selectedTab = signal(0);

  private stepTypeMap = new Map<string, RouteStepTypeInfo>();

  clientFilterOptions = computed(() => [
    { value: '', label: 'All (Global + Client)' },
    { value: '__global__', label: 'Global Only' },
    ...this.clients().map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
  ]);

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
    this.selectedTab.set(index);
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
