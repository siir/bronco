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
import { forkJoin, of, Subject } from 'rxjs';
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

interface PaletteItem {
  id: string;
  label: string;
  secondary?: string;
  icon: IconName;
  route: readonly string[];
  /** Optional query params applied when the item is activated. */
  queryParams?: Record<string, string>;
  section: PaletteSection;
  searchText: string;
}

type PaletteSection = 'clients' | 'probes' | 'users' | 'people' | 'navigate';

interface SectionGroup {
  section: PaletteSection;
  items: PaletteItem[];
}

const SECTION_ORDER: PaletteSection[] = ['clients', 'probes', 'users', 'people', 'navigate'];

const SECTION_LABELS: Record<PaletteSection, string> = {
  clients: 'Clients',
  probes: 'Scheduled Probes',
  users: 'Users',
  people: 'People',
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

const SCOPED_ALLOWED_PREFIXES = ['/dashboard', '/tickets', '/profile', '/login'];

function isAllowedForScoped(url: string): boolean {
  if (url === '/clients' || url.startsWith('/clients?')) return false;
  if (url.startsWith('/clients/')) return true;
  return SCOPED_ALLOWED_PREFIXES.some(
    p => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`),
  );
}

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
          placeholder="Search clients, probes, users, people, or navigate…"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="palette-listbox"
          [attr.aria-expanded]="filteredSections().length > 0"
          [attr.aria-activedescendant]="selectedItem() ? 'palette-item-' + selectedItem()!.id : null"
          [value]="query()"
          (input)="onQueryInput($event)"
          (keydown)="onInputKeydown($event)"
        />
        @if (loading()) {
          <app-icon name="spinner" size="sm" class="loading-icon" />
        }
      </div>

      @if (filteredSections().length > 0) {
        <div class="palette-results" id="palette-listbox" role="listbox">
          @for (group of filteredSections(); track group.section) {
            <div class="section-header" role="presentation">{{ sectionLabels[group.section] }}</div>
            @for (item of group.items; track item.id) {
              <div
                class="palette-item"
                role="option"
                [id]="'palette-item-' + item.id"
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
      padding: 10px 4px 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
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
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly searchInputRef = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly cancelLoad$ = new Subject<void>();

  readonly sectionLabels = SECTION_LABELS;
  readonly query = signal('');
  readonly items = signal<PaletteItem[]>([]);
  readonly loading = signal(false);
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
    return SECTION_ORDER
      .filter(s => itemMap.has(s))
      .map(s => ({ section: s, items: itemMap.get(s)! }));
  });

  readonly selectedItem = computed(() => {
    const idx = this.selectedIndex();
    const items = this.filteredItems();
    if (idx < 0 || idx >= items.length) return null;
    return items[idx];
  });

  constructor() {
    // Palette open/close lifecycle: fetch data on open, reset on close.
    effect((onCleanup) => {
      if (!this.paletteService.isOpen()) {
        this.cancelLoad$.next();
        untracked(() => {
          this.query.set('');
          this.items.set([]);
          this.loading.set(false);
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

    this.destroyRef.onDestroy(() => this.cancelLoad$.complete());
  }

  onOpenChange(open: boolean): void {
    if (!open) this.paletteService.close();
  }

  onQueryInput(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
  }

  onInputKeydown(e: KeyboardEvent): void {
    const items = this.filteredItems();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length === 0) return;
      const lastIndex = items.length - 1;
      this.selectedIndex.update(i => Math.max(0, Math.min(i + 1, lastIndex)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      const lastIndex = items.length - 1;
      this.selectedIndex.update(i => Math.max(0, Math.min(i - 1, lastIndex)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.selectedItem();
      if (item) this.activate(item);
    }
  }

  onItemHover(item: PaletteItem): void {
    const idx = this.filteredItems().indexOf(item);
    if (idx >= 0) this.selectedIndex.set(idx);
  }

  activate(item: PaletteItem): void {
    this.router.navigate([...item.route], item.queryParams ? { queryParams: item.queryParams } : undefined);
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

          const navRoutes = isScoped
            ? ALL_NAV_ROUTES.filter(r => isAllowedForScoped(r.route))
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
