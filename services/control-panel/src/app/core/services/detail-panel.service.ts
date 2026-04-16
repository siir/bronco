import { Injectable, signal, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Location } from '@angular/common';
import { ViewportService } from './viewport.service.js';

export type DetailEntityType = 'ticket' | 'client' | 'probe' | 'system' | 'analysis' | 'job';
export type DetailPanelMode = 'full' | 'compact';

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<DetailEntityType>([
  'ticket', 'client', 'probe', 'system', 'analysis', 'job',
]);
const VALID_MODES: ReadonlySet<string> = new Set<DetailPanelMode>(['full', 'compact']);

@Injectable({ providedIn: 'root' })
export class DetailPanelService {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly viewport = inject(ViewportService);

  readonly entityType = signal<DetailEntityType | null>(null);
  readonly entityId = signal<string | null>(null);
  readonly mode = signal<DetailPanelMode>('full');
  readonly isOpen = computed(() => this.entityId() !== null);

  /**
   * Open a detail view for the given entity. Behavior depends on viewport:
   *
   * - Desktop (`>= 768px`): set signals and merge `detail`/`type`/`mode` into
   *   the current URL's query params. The inline side pane renders.
   * - Mobile (`< 768px`): set signals AND navigate to `/detail/:type/:id`.
   *   The routed `DetailViewComponent` renders the same panel full-screen.
   *
   * Signals are always set so components observing the panel state work
   * identically across both code paths.
   */
  open(type: DetailEntityType, id: string, mode: DetailPanelMode = 'full'): void {
    this.setState(type, id, mode);
    if (this.viewport.isMobile()) {
      this.router.navigate(['/detail', type, id], {
        queryParams: { mode: mode === 'full' ? null : mode },
        queryParamsHandling: 'merge',
      });
    } else {
      this.router.navigate([], {
        queryParams: { detail: id, type, mode },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }
  }

  close(): void {
    this.dismiss();
    // On the routed detail view (`/detail/:type/:id`) the route itself is the
    // state — use history to return to wherever the user came from. This
    // covers both the mobile primary flow and the mobile→desktop resize
    // edge case. On desktop list pages we just clear the query params.
    if (this.router.url.startsWith('/detail/')) {
      this.location.back();
      return;
    }
    this.router.navigate([], {
      queryParams: { detail: null, type: null, mode: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Reset panel state without navigating — use when another navigation is already in progress. */
  dismiss(): void {
    this.entityType.set(null);
    this.entityId.set(null);
    this.mode.set('full');
  }

  /**
   * Hydrate panel state from route params (used by the mobile routed
   * DetailViewComponent). Validates entity type and mode the same way as
   * `restoreFromUrl` — an unknown type falls back to `ticket`.
   */
  setState(type: DetailEntityType, id: string, mode: DetailPanelMode = 'full'): void {
    this.mode.set(mode);
    this.entityType.set(type);
    this.entityId.set(id);
  }

  /**
   * Parse raw route params and hydrate panel state, or dismiss if params
   * describe no valid entity. Used by DetailViewComponent.
   */
  hydrateFromParams(params: { type?: string | null; id?: string | null; mode?: string | null }): void {
    if (params.id && VALID_ENTITY_TYPES.has(params.type ?? '')) {
      const type = params.type as DetailEntityType;
      const mode = VALID_MODES.has(params.mode ?? '') ? (params.mode as DetailPanelMode) : 'full';
      this.setState(type, params.id, mode);
    } else {
      this.dismiss();
    }
  }

  /** Call from shell on init to restore panel from query param */
  restoreFromUrl(params: { detail?: string; type?: string; mode?: string }): void {
    if (params.detail) {
      const type = VALID_ENTITY_TYPES.has(params.type ?? '') ? (params.type as DetailEntityType) : 'ticket';
      const mode = VALID_MODES.has(params.mode ?? '') ? (params.mode as DetailPanelMode) : 'full';
      this.entityType.set(type);
      this.entityId.set(params.detail);
      this.mode.set(mode);
    } else {
      // No detail param in URL → clear any in-memory panel state so the URL
      // remains the source of truth (covers back/forward and direct nav).
      this.dismiss();
    }
  }
}
