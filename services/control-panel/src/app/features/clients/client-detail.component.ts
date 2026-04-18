import { Component, DestroyRef, effect, inject, OnInit, signal, input, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TabGroupComponent, TabComponent } from '../../shared/components/index.js';
import { ClientHeaderComponent } from './client-detail/client-header.component.js';
import { ClientService, Client } from '../../core/services/client.service.js';
import { ClientSystemsTabComponent } from './client-detail/tabs/systems-tab.component.js';
import { ClientPeopleTabComponent } from './client-detail/tabs/people-tab.component.js';
import { ClientReposTabComponent } from './client-detail/tabs/repos-tab.component.js';
import { ClientIntegrationsTabComponent } from './client-detail/tabs/integrations-tab.component.js';
import { ClientTicketsTabComponent } from './client-detail/tabs/tickets-tab.component.js';
import { ClientMemoryTabComponent } from './client-detail/tabs/memory-tab.component.js';
import { ClientEnvironmentsTabComponent } from './client-detail/tabs/environments-tab.component.js';
import { ClientAiCredentialsTabComponent } from './client-detail/tabs/ai-credentials-tab.component.js';
import { ClientInvoicesTabComponent } from './client-detail/tabs/invoices-tab.component.js';
import { ClientAiUsageTabComponent } from './client-detail/tabs/ai-usage-tab.component.js';
import { ClientConfigTabComponent } from './client-detail/tabs/config-tab.component.js';

const CLIENT_DETAIL_TAB_SLUGS = [
  'systems',
  'people',
  'repos',
  'integrations',
  'tickets',
  'memory',
  'environments',
  'ai-credentials',
  'invoices',
  'ai-usage',
  'config',
] as const;
type ClientDetailTabSlug = (typeof CLIENT_DETAIL_TAB_SLUGS)[number];

@Component({
  standalone: true,
  imports: [
    TabGroupComponent, TabComponent, ClientHeaderComponent,
    ClientSystemsTabComponent, ClientPeopleTabComponent, ClientReposTabComponent, ClientIntegrationsTabComponent,
    ClientTicketsTabComponent, ClientMemoryTabComponent, ClientEnvironmentsTabComponent,
    ClientAiCredentialsTabComponent, ClientInvoicesTabComponent, ClientAiUsageTabComponent, ClientConfigTabComponent,
  ],
  template: `
    @if (client(); as c) {
      <app-client-header [client]="c" (clientChange)="onClientUpdated($event)" />

      <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="onTabChange($event)">
        <app-tab label="Systems">
          <app-client-systems-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="People">
          <app-client-people-tab [clientId]="id()" />
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

        <app-tab label="AI Credentials">
          <app-client-ai-credentials-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Invoices">
          <app-client-invoices-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="AI Usage">
          <app-client-ai-usage-tab [clientId]="id()" />
        </app-tab>

        <app-tab label="Config">
          <app-client-config-tab [client]="c" (clientChange)="onClientUpdated($event)" />
        </app-tab>
      </app-tab-group>
    } @else {
      <p class="loading">Loading…</p>
    }
  `,
  styles: [`
    :host { display: block; }

    .loading {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 14px;
      padding: 32px 16px;
      text-align: center;
    }
  `],
})
export class ClientDetailComponent implements OnInit {
  id = input.required<string>();

  private clientService = inject(ClientService);
  private destroyRef = inject(DestroyRef);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  client = signal<Client | null>(null);
  selectedTab = signal(0);

  constructor() {
    // Re-fetch whenever the :id route param changes. Without this, navigating
    // from /clients/A to /clients/B via the command palette (or any intra-
    // component router navigation) reuses the component instance and the
    // displayed client stays stale.
    //
    // Clearing client() to null first tears down the whole tab subtree via
    // the `@if (client(); as c)` guard in the template. When the new client
    // resolves, every tab component is reconstructed with the new clientId
    // input — fixes the 9 tabs that only fetch their data in ngOnInit and
    // would otherwise display the previous client's systems/people/repos/etc.
    // The brief "Loading…" flash is acceptable and makes the switch legible.
    //
    // With `withComponentInputBinding()` in app.config.ts, the router binds
    // `id` before this effect's first run. The try/catch is a defensive guard
    // against the documented edge case where a required input is read before
    // binding — extremely unlikely for a routed loadComponent but zero-cost.
    effect(() => {
      let cid: string;
      try {
        cid = this.id();
      } catch {
        return;
      }
      if (!cid) return;
      untracked(() => {
        this.client.set(null);
        this.load(cid);
      });
    });
  }

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
  }

  onTabChange(index: number): void {
    this.selectedTab.set(index);
    const slug: ClientDetailTabSlug = CLIENT_DETAIL_TAB_SLUGS[index] ?? CLIENT_DETAIL_TAB_SLUGS[0];
    this.router.navigate([], { queryParams: { tab: slug }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  load(cid: string = this.id()): void {
    this.clientService.getClient(cid).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(c => this.client.set(c));
  }

  onClientUpdated(updated: Client): void {
    this.client.set(updated);
  }
}
