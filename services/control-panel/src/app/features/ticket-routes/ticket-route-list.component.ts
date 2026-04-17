import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TicketRouteService, TicketRoute, TicketRouteStep, RouteStepTypeInfo } from '../../core/services/ticket-route.service.js';
import type { RouteType } from '../../core/services/ticket-route.service.js';
import { ClientService, Client } from '../../core/services/client.service.js';
import { TicketRouteDialogComponent } from './ticket-route-dialog.component.js';
import { TicketRouteStepDialogComponent } from './ticket-route-step-dialog.component.js';
import { DialogComponent } from '../../shared/components/dialog.component.js';
import {
  BroncoButtonComponent,
  SelectComponent,
  TabComponent,
  TabGroupComponent,
  ToggleSwitchComponent,
} from '../../shared/components/index.js';
import { ToastService } from '../../core/services/toast.service.js';

const TAB_LABELS = ['Ingestion Routes', 'Analysis Routes'] as const;

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
    BroncoButtonComponent,
    SelectComponent,
    TabComponent,
    TabGroupComponent,
    ToggleSwitchComponent,
    DialogComponent,
    TicketRouteDialogComponent,
    TicketRouteStepDialogComponent,
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
                  <app-bronco-button variant="ghost" size="sm" (click)="regenerateSummary(route)">✦</app-bronco-button>
                  <app-bronco-button variant="ghost" size="sm" (click)="editRoute(route)">Edit</app-bronco-button>
                  <app-bronco-button variant="ghost" size="sm" (click)="deleteRoute(route)">
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
                            <span [class]="'step-type-chip phase-' + stepPhase(s.stepType)">{{ s.stepType }}</span>
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
                              <app-bronco-button variant="ghost" size="sm" (click)="editStep(route, s)">Edit</app-bronco-button>
                              <app-bronco-button variant="ghost" size="sm" (click)="deleteStep(route, s)">
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

    @if (showRouteDialog()) {
      <app-dialog [open]="true" [title]="editingRoute() ? 'Edit Route' : 'Create Route'" maxWidth="550px" (openChange)="showRouteDialog.set(false)">
        <app-ticket-route-dialog-content
          [route]="editingRoute() ?? undefined"
          [clients]="clients()"
          [categories]="categories"
          [presetRouteType]="routeDialogType()"
          (saved)="onRouteSaved()"
          (cancelled)="showRouteDialog.set(false)" />
      </app-dialog>
    }

    @if (showStepDialog()) {
      <app-dialog [open]="true" [title]="editingStep() ? 'Edit Step' : 'Add Step'" maxWidth="550px" (openChange)="showStepDialog.set(false)">
        <app-ticket-route-step-dialog-content
          [routeId]="stepDialogRouteId()"
          [step]="editingStep() ?? undefined"
          [stepTypes]="stepTypes()"
          [nextOrder]="stepDialogNextOrder()"
          (saved)="onStepSaved()"
          (cancelled)="showStepDialog.set(false)" />
      </app-dialog>
    }
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
  private toast = inject(ToastService);
  private activatedRoute = inject(ActivatedRoute);
  private router = inject(Router);

  // Route dialog state
  showRouteDialog = signal(false);
  editingRoute = signal<TicketRoute | null>(null);
  routeDialogType = signal<RouteType>('ANALYSIS');

  // Step dialog state
  showStepDialog = signal(false);
  editingStep = signal<TicketRouteStep | null>(null);
  stepDialogRouteId = signal('');
  stepDialogNextOrder = signal<number | undefined>(undefined);

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
    const tabSlug = this.activatedRoute.snapshot.queryParamMap.get('tab');
    if (tabSlug) {
      const idx = TAB_LABELS.findIndex(l => this.toSlug(l) === tabSlug);
      if (idx >= 0) {
        this.selectedTab.set(idx);
        this.activeTab = idx === 0 ? 'INGESTION' : 'ANALYSIS';
      }
    }
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
    const slug = this.toSlug(TAB_LABELS[index] ?? '');
    this.router.navigate([], {
      relativeTo: this.activatedRoute,
      queryParams: { tab: slug || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private toSlug(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
    this.editingRoute.set(null);
    this.routeDialogType.set(routeType);
    this.showRouteDialog.set(true);
  }

  editRoute(route: TicketRoute): void {
    this.editingRoute.set(route);
    this.showRouteDialog.set(true);
  }

  onRouteSaved(): void {
    this.showRouteDialog.set(false);
    this.loadRoutes();
  }

  toggleActive(route: TicketRoute): void {
    const newState = !route.isActive;
    route.isActive = newState;
    this.routeService.updateRoute(route.id, { isActive: newState }).subscribe({
      next: () => {
        this.toast.success(`Route ${newState ? 'activated' : 'deactivated'}`);
        this.loadRoutes();
      },
      error: () => {
        route.isActive = !newState;
        this.toast.error('Failed to update route');
      },
    });
  }

  regenerateSummary(route: TicketRoute): void {
    this.toast.info('Generating summary...');
    this.routeService.regenerateSummary(route.id).subscribe({
      next: () => {
        this.toast.success('Summary updated');
        this.loadRoutes();
      },
      error: () => this.toast.error('Failed to generate summary'),
    });
  }

  deleteRoute(route: TicketRoute): void {
    if (!confirm(`Delete route "${route.name}"? This will also delete all its steps.`)) return;
    this.routeService.deleteRoute(route.id).subscribe({
      next: () => {
        this.toast.success('Route deleted');
        this.loadRoutes();
      },
      error: () => this.toast.error('Failed to delete route'),
    });
  }

  addStep(route: TicketRoute): void {
    const nextOrder = route.steps.length > 0
      ? Math.max(...route.steps.map((s) => s.stepOrder)) + 1
      : 1;
    this.editingStep.set(null);
    this.stepDialogRouteId.set(route.id);
    this.stepDialogNextOrder.set(nextOrder);
    this.showStepDialog.set(true);
  }

  editStep(route: TicketRoute, step: TicketRouteStep): void {
    this.editingStep.set(step);
    this.stepDialogRouteId.set(route.id);
    this.stepDialogNextOrder.set(undefined);
    this.showStepDialog.set(true);
  }

  onStepSaved(): void {
    this.showStepDialog.set(false);
    this.loadRoutes();
  }

  toggleStepActive(route: TicketRoute, step: TicketRouteStep): void {
    const newState = !step.isActive;
    step.isActive = newState;
    this.routeService.updateStep(route.id, step.id, { isActive: newState }).subscribe({
      next: () => {
        this.toast.success(`Step ${newState ? 'activated' : 'deactivated'}`);
        this.loadRoutes();
      },
      error: () => {
        step.isActive = !newState;
        this.toast.error('Failed to update step');
      },
    });
  }

  deleteStep(route: TicketRoute, step: TicketRouteStep): void {
    if (!confirm(`Delete step "${step.name}"?`)) return;
    this.routeService.deleteStep(route.id, step.id).subscribe({
      next: () => {
        this.toast.success('Step deleted');
        this.loadRoutes();
      },
      error: () => this.toast.error('Failed to delete step'),
    });
  }
}
