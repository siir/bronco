import { Injectable, signal, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

export type DetailEntityType = 'ticket' | 'client' | 'probe' | 'system' | 'analysis' | 'job';
export type DetailPanelMode = 'full' | 'compact';

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<DetailEntityType>([
  'ticket', 'client', 'probe', 'system', 'analysis', 'job',
]);
const VALID_MODES: ReadonlySet<string> = new Set<DetailPanelMode>(['full', 'compact']);

@Injectable({ providedIn: 'root' })
export class DetailPanelService {
  private readonly router = inject(Router);

  readonly entityType = signal<DetailEntityType | null>(null);
  readonly entityId = signal<string | null>(null);
  readonly mode = signal<DetailPanelMode>('full');
  readonly isOpen = computed(() => this.entityId() !== null);

  open(type: DetailEntityType, id: string, mode: DetailPanelMode = 'full'): void {
    this.mode.set(mode);
    this.entityType.set(type);
    this.entityId.set(id);
    this.router.navigate([], {
      queryParams: { detail: id, type, mode },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  close(): void {
    this.entityType.set(null);
    this.entityId.set(null);
    this.mode.set('full');
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
