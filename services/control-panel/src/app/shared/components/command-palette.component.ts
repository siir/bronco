import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { debounceTime, distinctUntilChanged, forkJoin, of, Subject, switchMap } from 'rxjs';
import { catchError, map, takeUntil } from 'rxjs/operators';
import { DialogComponent } from './dialog.component.js';
import { IconComponent } from './icon.component.js';
import type { IconName } from './icon-registry.js';
import { CommandPaletteService } from '../../core/services/command-palette.service.js';
import { AuthService } from '../../core/services/auth.service.js';
import { ClientService, type Client } from '../../core/services/client.service.js';
import { ScheduledProbeService, type ScheduledProbe } from '../../core/services/scheduled-probe.service.js';
import { UserService, type ControlPanelUser } from '../../core/services/user.service.js';
import { PersonService, type Person } from '../../core/services/person.service.js';
import { TicketService, type TicketSearchResult } from '../../core/services/ticket.service.js';
import { ThemeService } from '../../core/services/theme.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { isScopedOpsAllowedPath } from '../../core/guards/scoped-ops-allowlist.js';

interface PaletteItem {
  id: string;
  label: string;
  secondary?: string;
  icon: IconName;
  route?: readonly string[];
  /** Optional query params applied when the item is activated. */
  queryParams?: Record<string, string>;
  /** Callback fired on activation — exclusive with route. */
  action?: () => void;
  section: PaletteSection;
  searchText: string;
}

type PaletteSection = 'clients' | 'tickets' | 'probes' | 'users' | 'people' | 'commands' | 'navigate';

interface SectionGroup {
  section: PaletteSection;
  label: string;
  items: PaletteItem[];
  loading?: boolean;
}

const SECTION_ORDER: PaletteSection[] = ['clients', 'tickets', 'probes', 'users', 'people', 'commands', 'navigate'];

const SECTION_LABELS: Record<PaletteSection, string> = {
  clients: 'Clients',
  tickets: 'Tickets',
  probes: 'Scheduled Probes',
  users: 'Users',
  people: 'People',
  commands: 'Commands',
  navigate: 'Navigate',
};

interface NavRoute {
  label: string;
  route: string;
  icon: IconName;
}

const ALL_NAV_ROUTES: NavRoute[] = [
  { label: 'Dashboard', route: '/dashboard', icon: 'home' },
  { label: 'Tickets', route: '/tickets', icon: 'ticket' },
  { label: 'Activity Feed', route: '/activity', icon: 'bell' },
  { label: 'Clients', route: '/clients', icon: 'building' },
  { label: 'Scheduled Probes', route: '/scheduled-probes', icon: 'clock' },
  { label: 'Ingestion Jobs', route: '/ingestion-jobs', icon: 'play' },
  { label: 'Failed Jobs', route: '/failed-jobs', icon: 'warning' },
  { label: 'Logs', route: '/logs', icon: 'file' },
  { label: 'Email Log', route: '/email-logs', icon: 'email' },
  { label: 'AI Prompts', route: '/prompts', icon: 'sparkles' },
  { label: 'AI Providers', route: '/ai-providers', icon: 'robot' },
  { label: 'AI Usage', route: '/ai-usage', icon: 'bolt' },
  { label: 'Ticket Routes', route: '/ticket-routes', icon: 'tag' },
  { label: 'System Analysis', route: '/system-analysis', icon: 'search' },
  { label: 'System Issues', route: '/system-issues', icon: 'warning' },
  { label: 'Slack Conversations', route: '/slack-conversations', icon: 'comment' },
  { label: 'Release Notes', route: '/release-notes', icon: 'book' },
  { label: 'System Status', route: '/system-status', icon: 'server' },
  { label: 'Settings', route: '/settings', icon: 'gear' },
  { label: 'User Maintenance', route: '/users', icon: 'user' },
  { label: 'Profile', route: '/profile', icon: 'user' },
  { label: 'Notifications', route: '/notification-preferences', icon: 'bell' },
];

@Component({
  selector: 'app-command-palette',
  standalone: true,
  imports: [DialogComponent, IconComponent],
  template: `
    <app-dialog
      [open]="paletteService.isOpen()"
      [maxWidth]="'640px'"
      (openChange)="onOpenChange($event)">
      <div class="palette-search-row">
        <app-icon name="search" size="md" class="search-icon" />
        <input
          #searchInput
          type="text"
          class="palette-input"
          placeholder="Search clients, tickets, probes, users, people, or navigate…"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-controls="command-palette-listbox"
          [attr.aria-expanded]="filteredSections().length > 0"
          aria-autocomplete="list"
          [attr.aria-activedescendant]="selectedItem() ? itemDomId(selectedItem()!) : null"
          [value]="query()"
          (input)="onQueryInput($event)"
          (keydown)="onInputKeydown($event)"
        />
        @if (loading()) {
          <app-icon name="spinner" size="sm" class="loading-icon" />
        }
      </div>

      @if (filteredSections().length > 0) {
        <div class="palette-results" role="listbox" id="command-palette-listbox">
          @for (group of filteredSections(); track group.section) {
            <div class="section-header" role="presentation">
              {{ group.label }}
              @if (group.loading) {
                <app-icon name="spinner" size="sm" class="section-spinner" />
              }
            </div>
            @for (item of group.items; track item.id) {
              <div
                class="palette-item"
                role="option"
                [id]="itemDomId(item)"
                [attr.aria-selected]="selectedItem() === item"
                [class.palette-item-selected]="selectedItem() === item"
                (click)="activate(item)"
                (mouseenter)="onItemHover(item)">
                <app-icon [name]="item.icon" size="md" class="item-icon" />
                <span class="item-label">{{ item.label }}</span>
                @if (item.secondary) {
                  <span class="item-secondary">{{ item.secondary }}</span>
                }
              </div>
            }
          }
        </div>
      } @else if (query().trim()) {
        <div class="palette-empty">No results.</div>
      } @else if (!loading() && items().length === 0) {
        <div class="palette-empty">Loading…</div>
      }
    </app-dialog>
  `,
  styles: [`
    .palette-search-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-light);
      margin-bottom: 4px;
    }
    .search-icon {
      color: var(--text-tertiary);
      flex-shrink: 0;
    }
    .palette-input {
      flex: 1;
      background: none;
      border: none;
      outline: none;
      font-family: var(--font-primary);
      font-size: 16px;
      color: var(--text-primary);
      min-width: 0;
    }
    .palette-input::placeholder {
      color: var(--text-tertiary);
    }
    .loading-icon {
      color: var(--text-tertiary);
      flex-shrink: 0;
      animation: palette-spin 1s linear infinite;
    }
    @keyframes palette-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .palette-results {
      max-height: 440px;
      overflow-y: auto;
    }
    .section-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 4px 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
    }
    .section-spinner {
      color: var(--text-tertiary);
      animation: palette-spin 1s linear infinite;
    }
    .palette-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background 80ms ease;
      color: var(--text-secondary);
    }
    .palette-item:hover {
      background: var(--bg-hover);
    }
    .palette-item-selected {
      background: var(--bg-active);
      color: var(--accent);
    }
    .palette-item-selected .item-secondary {
      color: var(--accent);
      opacity: 0.75;
    }
    .item-icon {
      flex-shrink: 0;
      color: currentColor;
    }
    .item-label {
      flex: 1;
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .item-secondary {
      font-size: 11px;
      color: var(--text-tertiary);
      flex-shrink: 0;
    }
    .palette-empty {
      padding: 32px 8px;
      text-align: center;
      font-size: 13px;
      color: var(--text-tertiary);
    }
  `],
})
export class CommandPaletteComponent {
  readonly paletteService = inject(CommandPaletteService);
  private readonly auth = inject(AuthService);
  private readonly clientService = inject(ClientService);
  private readonly probeService = inject(ScheduledProbeService);
  private readonly userService = inject(UserService);
  private readonly personService = inject(PersonService);
  private readonly ticketService = inject(TicketService);
  private readonly theme = inject(ThemeService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly searchInputRef = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly cancelLoad$ = new Subject<void>();
  private readonly ticketSearch$ = new Subject<string>();

  readonly query = signal('');
  readonly items = signal<PaletteItem[]>([]);
  readonly ticketItems = signal<PaletteItem[]>([]);
  readonly loading = signal(false);
  readonly ticketsLoading = signal(false);
  readonly selectedIndex = signal(0);

  readonly filteredItems = computed(() => {
    const q = this.query().toLowerCase().trim();
    const all = this.items();
    if (!q) return all;
    const filtered = all.filter(it => it.searchText.includes(q));
    return [...filtered].sort((a, b) => {
      const sectionDiff = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
      if (sectionDiff !== 0) return sectionDiff;
      const aStarts = a.label.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.label.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts;
    });
  });

  readonly filteredSections = computed<SectionGroup[]>(() => {
    const itemMap = new Map<PaletteSection, PaletteItem[]>();
    for (const item of this.filteredItems()) {
      const bucket = itemMap.get(item.section) ?? [];
      bucket.push(item);
      itemMap.set(item.section, bucket);
    }

    // Ticket items are pre-filtered server-side; merge them separately.
    const tickets = this.ticketItems();
    const isTicketsLoading = this.ticketsLoading();
    if (tickets.length > 0 || isTicketsLoading) {
      itemMap.set('tickets', tickets);
    }

    return SECTION_ORDER
      .filter(s => itemMap.has(s))
      .map(s => ({
        section: s,
        label: SECTION_LABELS[s],
        items: itemMap.get(s)!,
        loading: s === 'tickets' && isTicketsLoading,
      }));
  });

  readonly selectedItem = computed(() => {
    const idx = this.selectedIndex();
    const items = this.filteredItems();
    // Flatten all section items for keyboard nav (includes ticket items)
    const allVisible = this.filteredSections().flatMap(g => g.items);
    if (idx < 0 || idx >= allVisible.length) return null;
    return allVisible[idx];
  });

  constructor() {
    // Palette open/close lifecycle: fetch data on open, reset on close.
    effect((onCleanup) => {
      if (!this.paletteService.isOpen()) {
        this.cancelLoad$.next();
        untracked(() => {
          this.query.set('');
          this.items.set([]);
          this.ticketItems.set([]);
          this.loading.set(false);
          this.ticketsLoading.set(false);
          this.selectedIndex.set(0);
        });
        return;
      }
      untracked(() => this.loadItems());
      // Refocus the search input after Angular renders the dialog content and
      // after DialogComponent's own queueMicrotask auto-focus (which targets
      // the close button) has already run.
      const handle = setTimeout(() => {
        this.searchInputRef()?.nativeElement.focus();
      }, 0);
      onCleanup(() => clearTimeout(handle));
    });

    // Reset selection to first item whenever the query changes.
    effect(() => {
      this.query();
      untracked(() => this.selectedIndex.set(0));
    });

    // Drive the debounced ticket search from the query signal.
    effect(() => {
      const q = this.query().trim();
      untracked(() => this.ticketSearch$.next(q));
    });

    this.ticketSearch$
      .pipe(
        debounceTime(200),
        distinctUntilChanged(),
        switchMap(q => {
          if (q.length < 2) {
            this.ticketsLoading.set(false);
            this.ticketItems.set([]);
            return of([] as TicketSearchResult[]);
          }
          this.ticketsLoading.set(true);
          return this.ticketService.searchTickets(q, 20).pipe(
            catchError(() => of([] as TicketSearchResult[])),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(results => {
        this.ticketsLoading.set(false);
        this.ticketItems.set(results.map(t => ({
          id: `ticket:${t.id}`,
          label: t.subject,
          secondary: `#${t.ticketNumber ?? '?'} · ${t.clientShortCode}`,
          icon: 'ticket' as IconName,
          route: ['/tickets', t.id] as const,
          section: 'tickets' as const,
          searchText: `${t.subject} ${t.ticketNumber ?? ''} ${t.clientShortCode} ${t.clientName}`.toLowerCase(),
        })));
      });

    this.destroyRef.onDestroy(() => this.cancelLoad$.complete());
  }

  onOpenChange(open: boolean): void {
    if (!open) this.paletteService.close();
  }

  onQueryInput(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
  }

  onInputKeydown(e: KeyboardEvent): void {
    const allVisible = this.filteredSections().flatMap(g => g.items);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (allVisible.length === 0) return;
      this.selectedIndex.update(i => Math.min(i + 1, allVisible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (allVisible.length === 0) return;
      this.selectedIndex.update(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.selectedItem();
      if (item) this.activate(item);
    }
  }

  onItemHover(item: PaletteItem): void {
    const allVisible = this.filteredSections().flatMap(g => g.items);
    const idx = allVisible.indexOf(item);
    if (idx >= 0) this.selectedIndex.set(idx);
  }

  /**
   * Stable DOM id for each option row, consumed by the input's
   * `aria-activedescendant` so screen readers announce the active option
   * without the results container needing its own focus.
   */
  itemDomId(item: PaletteItem): string {
    // Replace colons so the id is a valid CSS/DOM id — `client:abc` → `client_abc`.
    return `cp-item-${item.id.replace(/:/g, '_')}`;
  }

  activate(item: PaletteItem): void {
    if (item.action) {
      item.action();
    } else if (item.route) {
      this.router.navigate([...item.route], item.queryParams ? { queryParams: item.queryParams } : undefined);
    }
    this.paletteService.close();
  }

  private loadItems(): void {
    const user = this.auth.currentUser();
    const isScoped = user?.isPortalOpsUser === true && !!user.clientId;
    const clientId = user?.clientId ?? null;

    this.loading.set(true);

    const clients$ = isScoped && clientId
      ? this.clientService.getClient(clientId).pipe(map(c => [c] as Client[]))
      : this.clientService.getClients();

    const probes$ = this.probeService.getProbes(
      isScoped && clientId ? { clientId } : undefined,
    );

    // Scoped ops users cannot access /users (operator accounts).
    const users$ = isScoped
      ? of([] as ControlPanelUser[])
      : this.userService.getUsers();

    // PersonService.getPeople requires a clientId. For full operators without a
    // client scope, the people section is omitted. A dedicated all-people search
    // endpoint would be needed to support it (tracked for Phase B).
    const people$ = clientId
      ? this.personService.getPeople(clientId)
      : of([] as Person[]);

    forkJoin({
      clients: clients$.pipe(catchError(() => of([] as Client[]))),
      probes: probes$.pipe(catchError(() => of([] as ScheduledProbe[]))),
      users: users$.pipe(catchError(() => of([] as ControlPanelUser[]))),
      people: people$.pipe(catchError(() => of([] as Person[]))),
    })
      .pipe(
        takeUntil(this.cancelLoad$),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ clients, probes, users, people }) => {
          const newItems: PaletteItem[] = [];

          for (const c of clients) {
            newItems.push({
              id: `client:${c.id}`,
              label: c.name,
              secondary: c.shortCode,
              icon: 'building',
              route: ['/clients', c.id],
              section: 'clients',
              searchText: `${c.name} ${c.shortCode}`.toLowerCase(),
            });
          }

          for (const p of probes) {
            newItems.push({
              id: `probe:${p.id}`,
              label: p.name,
              secondary: p.client?.name,
              icon: 'clock',
              route: ['/scheduled-probes', p.id, 'runs'],
              section: 'probes',
              searchText: `${p.name} ${p.client?.name ?? ''}`.toLowerCase(),
            });
          }

          for (const u of users) {
            newItems.push({
              id: `user:${u.id}`,
              label: u.name,
              // Email disambiguates multiple users with the same display name —
              // role (ADMIN / OPERATOR) doesn't.
              secondary: u.email,
              icon: 'user',
              route: ['/users'],
              // user-list reads ?edit=<id> and auto-opens the edit dialog.
              queryParams: { edit: u.id },
              section: 'users',
              searchText: `${u.name} ${u.email} ${u.role}`.toLowerCase(),
            });
          }

          for (const p of people) {
            newItems.push({
              id: `person:${p.id}`,
              label: p.name,
              secondary: p.client?.name,
              icon: 'user',
              route: ['/clients', p.clientId],
              section: 'people',
              searchText: `${p.name} ${p.email} ${p.client?.name ?? ''}`.toLowerCase(),
            });
          }

          // Commands — static actions; Create commands hidden for scoped users.
          if (!isScoped) {
            newItems.push({
              id: 'cmd:create-ticket',
              label: 'Create Ticket',
              icon: 'add',
              route: ['/tickets'],
              queryParams: { create: '1' },
              section: 'commands',
              searchText: 'create ticket',
            });
            newItems.push({
              id: 'cmd:create-client',
              label: 'Create Client',
              icon: 'add',
              route: ['/clients'],
              queryParams: { create: '1' },
              section: 'commands',
              searchText: 'create client',
            });
            newItems.push({
              id: 'cmd:create-probe',
              label: 'Create Scheduled Probe',
              icon: 'add',
              route: ['/scheduled-probes'],
              queryParams: { create: '1' },
              section: 'commands',
              searchText: 'create scheduled probe',
            });
          }

          newItems.push({
            id: 'cmd:switch-theme',
            label: 'Switch Theme',
            icon: 'sparkles',
            action: () => {
              const next = this.theme.cycleToNext();
              this.toast.info(`Theme: ${next.name}`);
            },
            section: 'commands',
            searchText: 'switch theme',
          });

          newItems.push({
            id: 'cmd:logout',
            label: 'Logout',
            icon: 'close',
            action: () => this.auth.logout(),
            section: 'commands',
            searchText: 'logout',
          });

          const navRoutes = isScoped
            ? ALL_NAV_ROUTES.filter(r => isScopedOpsAllowedPath(r.route))
            : ALL_NAV_ROUTES;

          for (const r of navRoutes) {
            newItems.push({
              id: `nav:${r.route}`,
              label: `Go to ${r.label}`,
              icon: r.icon,
              route: [r.route],
              section: 'navigate',
              searchText: `go to ${r.label}`.toLowerCase(),
            });
          }

          this.items.set(newItems);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }
}
