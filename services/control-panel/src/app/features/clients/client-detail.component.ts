import { Component, DestroyRef, inject, OnInit, signal, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { JsonPipe, DatePipe, SlicePipe, DecimalPipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatChipsModule } from '@angular/material/chips';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TabGroupComponent, TabComponent } from '../../shared/components/index.js';
import { ClientHeaderComponent } from './client-detail/client-header.component';
import { ClientService, Client } from '../../core/services/client.service';
import { DialogComponent } from '../../shared/components/dialog.component';
import { ClientSystemsTabComponent } from './client-detail/tabs/systems-tab.component';
import { ClientContactsTabComponent } from './client-detail/tabs/contacts-tab.component';
import { ClientReposTabComponent } from './client-detail/tabs/repos-tab.component';
import { ClientIntegrationsTabComponent } from './client-detail/tabs/integrations-tab.component';
import { ClientTicketsTabComponent } from './client-detail/tabs/tickets-tab.component';
import { ClientMemoryTabComponent } from './client-detail/tabs/memory-tab.component';
import { ClientEnvironmentsTabComponent } from './client-detail/tabs/environments-tab.component';
import { ClientUsersTabComponent } from './client-detail/tabs/users-tab.component';
import { ClientAiCredentialsTabComponent } from './client-detail/tabs/ai-credentials-tab.component';
import { ClientInvoicesTabComponent } from './client-detail/tabs/invoices-tab.component';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { AiUsageService, type AiUsageClientSummary, type AiUsageLogEntry } from '../../core/services/ai-usage.service';
import { ToastService } from '../../core/services/toast.service';

const CLIENT_DETAIL_TAB_SLUGS = [
  'systems',
  'contacts',
  'repos',
  'integrations',
  'tickets',
  'memory',
  'environments',
  'users',
  'ai-credentials',
  'invoices',
  'ai-usage',
] as const;
type ClientDetailTabSlug = (typeof CLIENT_DETAIL_TAB_SLUGS)[number];
const AI_USAGE_TAB_INDEX = CLIENT_DETAIL_TAB_SLUGS.indexOf('ai-usage');

@Component({
  standalone: true,
  imports: [
    RouterLink, DatePipe, SlicePipe, DecimalPipe, MatCardModule, MatButtonModule, MatIconModule,
    MatTableModule, MatChipsModule, MatSlideToggleModule, MatTooltipModule,
    FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    TabGroupComponent, TabComponent, ClientHeaderComponent,
    ClientSystemsTabComponent, ClientContactsTabComponent, ClientReposTabComponent, ClientIntegrationsTabComponent,
    ClientTicketsTabComponent, ClientMemoryTabComponent, ClientEnvironmentsTabComponent, ClientUsersTabComponent,
    ClientAiCredentialsTabComponent, ClientInvoicesTabComponent,
    DialogComponent,
  ],
  template: `
    @if (client(); as c) {
      <app-client-header [client]="c" (clientChange)="onClientUpdated($event)" />

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">
        <app-tab label="Systems">
          <app-client-systems-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Contacts">
          <app-client-contacts-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Repos">
          <app-client-repos-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Integrations">
          <app-client-integrations-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Tickets">
          <app-client-tickets-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Memory">
          <app-client-memory-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Environments">
          <app-client-environments-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Users">
          <app-client-users-tab [clientId]="id()" />
        </app-tab>
        <app-tab label="AI Credentials">
          <app-client-ai-credentials-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Invoices">
          <app-client-invoices-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="AI Usage">
          <div class="tab-content">
            <div class="tab-header">
              <h3>AI Usage</h3>
              <button mat-raised-button (click)="loadAiUsage()">
                <mat-icon>refresh</mat-icon> Refresh
              </button>
            </div>
            @if (aiUsageLoading()) {
              <p>Loading AI usage data...</p>
            } @else if (aiUsageSummary()) {
              <div class="kpi-grid">
                @for (w of aiUsageSummary()!.windows; track w.label) {
                  <mat-card class="kpi-card">
                    <mat-card-header><mat-card-title>{{ w.label }}</mat-card-title></mat-card-header>
                    <mat-card-content>
                      <div class="kpi-row"><span class="kpi-label">Tokens In</span><span class="kpi-value">{{ w.inputTokens | number }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Tokens Out</span><span class="kpi-value">{{ w.outputTokens | number }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Base Cost</span><span class="kpi-value">\${{ w.baseCostUsd | number:'1.4-4' }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Billed Cost</span><span class="kpi-value kpi-billed">\${{ w.billedCostUsd | number:'1.4-4' }}</span></div>
                      <div class="kpi-row"><span class="kpi-label">Requests</span><span class="kpi-value">{{ w.requestCount | number }}</span></div>
                    </mat-card-content>
                  </mat-card>
                }
              </div>
              <p class="markup-note">Billing markup: {{ aiUsageSummary()!.billingMarkupPercent }}x</p>

              <h4>Prompt Log</h4>
              <div class="log-nav">
                <button mat-button [disabled]="aiUsagePage() <= 0" (click)="aiUsagePrevPage()">Previous</button>
                <span>Page {{ aiUsagePage() + 1 }} of {{ aiUsageTotalPages() }}</span>
                <button mat-button [disabled]="aiUsagePage() >= aiUsageTotalPages() - 1" (click)="aiUsageNextPage()">Next</button>
              </div>
              <table mat-table [dataSource]="aiUsageLogs()" class="full-width">
                <ng-container matColumnDef="createdAt">
                  <th mat-header-cell *matHeaderCellDef>Time</th>
                  <td mat-cell *matCellDef="let l">{{ l.createdAt | date:'short' }}</td>
                </ng-container>
                <ng-container matColumnDef="taskType">
                  <th mat-header-cell *matHeaderCellDef>Task</th>
                  <td mat-cell *matCellDef="let l">{{ l.taskType }}</td>
                </ng-container>
                <ng-container matColumnDef="model">
                  <th mat-header-cell *matHeaderCellDef>Model</th>
                  <td mat-cell *matCellDef="let l">{{ l.model }}</td>
                </ng-container>
                <ng-container matColumnDef="provider">
                  <th mat-header-cell *matHeaderCellDef>Provider</th>
                  <td mat-cell *matCellDef="let l">{{ l.provider }}</td>
                </ng-container>
                <ng-container matColumnDef="inputTokens">
                  <th mat-header-cell *matHeaderCellDef>In</th>
                  <td mat-cell *matCellDef="let l">{{ l.inputTokens | number }}</td>
                </ng-container>
                <ng-container matColumnDef="outputTokens">
                  <th mat-header-cell *matHeaderCellDef>Out</th>
                  <td mat-cell *matCellDef="let l">{{ l.outputTokens | number }}</td>
                </ng-container>
                <ng-container matColumnDef="costUsd">
                  <th mat-header-cell *matHeaderCellDef>Cost</th>
                  <td mat-cell *matCellDef="let l">{{ l.costUsd != null ? '\$' + (l.costUsd | number:'1.4-4') : '-' }}</td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="aiUsageLogColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: aiUsageLogColumns;"></tr>
              </table>
              @if (aiUsageLogs().length === 0) { <p class="empty">No AI usage logs for this client.</p> }
            } @else {
              <p class="empty">No AI usage data available. Click Refresh to load.</p>
            }
          </div>
        </app-tab>
      </app-tab-group>
    } @else {
      <p>Loading...</p>
    }

  `,
  styles: [`
    .tab-content { padding: 16px 0; }
    .tab-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .tab-header h3 { margin: 0; }
    .full-width { width: 100%; }
    .link { text-decoration: none; color: #3f51b5; }
    .engine-chip { font-size: 11px; padding: 2px 6px; background: #e0f2f1; border-radius: 4px; color: #00695c; font-family: monospace; }
    .inactive { opacity: 0.5; }
    .primary-icon { color: #f9a825; font-size: 20px; }
    .empty { color: #999; padding: 16px; text-align: center; }
    .integration-card { margin-bottom: 12px; }
    .integ-header { display: flex; align-items: center; gap: 8px; }
    .integ-notes { color: #666; margin: 8px 0 4px; }
    .label-chip { font-size: 11px; padding: 2px 6px; background: #e8f5e9; border-radius: 4px; color: #2e7d32; font-family: monospace; }
    .config-preview { background: #f5f5f5; padding: 8px 12px; border-radius: 4px; font-size: 12px; overflow-x: auto; }
    .spacer { flex: 1; }
    .priority { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
    .priority-critical { background: #ffebee; color: #c62828; }
    .priority-high { background: #fff3e0; color: #e65100; }
    .priority-medium { background: #e3f2fd; color: #1565c0; }
    .priority-low { background: #e8f5e9; color: #2e7d32; }
    code { font-size: 13px; }
    .memory-card { margin-bottom: 12px; }
    .memory-card.inactive-card { opacity: 0.5; }
    .memory-header { display: flex; align-items: center; gap: 8px; }
    .type-chip { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .type-context { background: #e3f2fd; color: #1565c0; }
    .type-playbook { background: #fce4ec; color: #c62828; }
    .type-tool_guidance { background: #f3e5f5; color: #6a1b9a; }
    .source-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
    .source-manual { background: #f5f5f5; color: #999; }
    .source-ai_learned { background: #ede7f6; color: #6a1b9a; }
    .category-chip { font-size: 11px; padding: 2px 6px; background: #fff3e0; color: #e65100; border-radius: 4px; }
    .tags { display: flex; gap: 4px; margin: 8px 0 4px; flex-wrap: wrap; }
    .tag-chip { font-size: 11px; padding: 2px 6px; background: #f5f5f5; color: #616161; border-radius: 4px; }
    .memory-content { background: #fafafa; padding: 8px 12px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-wrap: break-word; max-height: 200px; overflow-y: auto; }
    .type-admin { background: #e3f2fd; color: #1565c0; }
    .env-card { margin-bottom: 12px; }
    .env-card.inactive-card { opacity: 0.5; }
    .env-header { display: flex; align-items: center; gap: 8px; }
    .env-desc { color: #666; margin: 8px 0 4px; }
    .default-chip { font-size: 11px; padding: 2px 6px; background: #e3f2fd; color: #1565c0; border-radius: 4px; font-weight: 600; }
    .status-final { background: #e8f5e9; color: #2e7d32; }
    .add-cred-card { margin-top: 16px; }
    .add-cred-card h4 { margin: 0 0 12px; }
    .cred-form { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .cred-form mat-form-field { flex: 1; min-width: 160px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 12px; }
    .kpi-card { }
    .kpi-row { display: flex; justify-content: space-between; padding: 2px 0; }
    .kpi-label { color: #666; font-size: 13px; }
    .kpi-value { font-weight: 500; font-family: monospace; font-size: 13px; }
    .kpi-billed { color: #2e7d32; font-weight: 600; }
    .markup-note { color: #888; font-size: 12px; margin-bottom: 16px; }
    .log-nav { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  `],
})
export class ClientDetailComponent implements OnInit {
  id = input.required<string>();

  private clientService = inject(ClientService);
  private aiUsageService = inject(AiUsageService);
  private destroyRef = inject(DestroyRef);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  client = signal<Client | null>(null);
  aiUsageSummary = signal<AiUsageClientSummary | null>(null);
  aiUsageLogs = signal<AiUsageLogEntry[]>([]);
  aiUsageLoading = signal(false);
  aiUsagePage = signal(0);
  aiUsageTotal = signal(0);
  aiUsageTotalPages = signal(1);
  selectedTab = signal(0);

  aiUsageLogColumns = ['createdAt', 'taskType', 'model', 'provider', 'inputTokens', 'outputTokens', 'costUsd'];
  private readonly AI_USAGE_PAGE_SIZE = 25;

  ngOnInit(): void {
    const tabParam = this.route.snapshot.queryParamMap.get('tab');
    if (tabParam !== null) {
      const slugIdx = (CLIENT_DETAIL_TAB_SLUGS as readonly string[]).indexOf(tabParam);
      if (slugIdx >= 0) {
        this.selectedTab.set(slugIdx);
      } else {
        // Backwards compat: numeric ?tab=N from older bookmarks.
        const tab = Number(tabParam);
        if (Number.isInteger(tab) && tab >= 0 && tab < CLIENT_DETAIL_TAB_SLUGS.length) {
          this.selectedTab.set(tab);
        }
      }
    }
    this.load();
    if (this.selectedTab() === AI_USAGE_TAB_INDEX) this.loadAiUsage();
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    const slug: ClientDetailTabSlug = CLIENT_DETAIL_TAB_SLUGS[index] ?? CLIENT_DETAIL_TAB_SLUGS[0];
    this.router.navigate([], { queryParams: { tab: slug }, queryParamsHandling: 'merge', replaceUrl: true });
    if (index === AI_USAGE_TAB_INDEX && !this.aiUsageSummary()) this.loadAiUsage();
  }

  load(): void {
    const cid = this.id();
    this.clientService.getClient(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(c => this.client.set(c));
  }

  loadAiUsage(): void {
    const cid = this.id();
    this.aiUsageLoading.set(true);
    this.aiUsageService.getClientSummary(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (summary) => {
        this.aiUsageSummary.set(summary);
        this.aiUsageLoading.set(false);
      },
      error: () => this.aiUsageLoading.set(false),
    });
    this.loadAiUsageLogs();
  }

  private loadAiUsageLogs(): void {
    const cid = this.id();
    const page = this.aiUsagePage();
    this.aiUsageService.getClientLogs(cid, { limit: this.AI_USAGE_PAGE_SIZE, offset: page * this.AI_USAGE_PAGE_SIZE })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        this.aiUsageLogs.set(res.logs);
        this.aiUsageTotal.set(res.total);
        this.aiUsageTotalPages.set(Math.max(1, Math.ceil(res.total / this.AI_USAGE_PAGE_SIZE)));
      });
  }

  aiUsagePrevPage(): void {
    if (this.aiUsagePage() > 0) {
      this.aiUsagePage.update(p => p - 1);
      this.loadAiUsageLogs();
    }
  }

  aiUsageNextPage(): void {
    if (this.aiUsagePage() < this.aiUsageTotalPages() - 1) {
      this.aiUsagePage.update(p => p + 1);
      this.loadAiUsageLogs();
    }
  }

  onClientUpdated(updated: Client): void {
    this.client.set(updated);
  }


}
