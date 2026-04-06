import { Injectable, signal, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

export type DetailEntityType = 'ticket' | 'client' | 'probe' | 'system' | 'analysis' | 'job';

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<DetailEntityType>([
  'ticket', 'client', 'probe', 'system', 'analysis', 'job',
]);

@Injectable({ providedIn: 'root' })
export class DetailPanelService {
  private readonly router = inject(Router);

  readonly entityType = signal<DetailEntityType | null>(null);
  readonly entityId = signal<string | null>(null);
  readonly isOpen = computed(() => this.entityId() !== null);

  open(type: DetailEntityType, id: string): void {
    this.entityType.set(type);
    this.entityId.set(id);
    this.router.navigate([], {
      queryParams: { detail: id, type },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  close(): void {
    this.entityType.set(null);
    this.entityId.set(null);
    this.router.navigate([], {
      queryParams: { detail: null, type: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Call from shell on init to restore panel from query param */
  restoreFromUrl(params: { detail?: string; type?: string }): void {
    if (params.detail) {
      const type = VALID_ENTITY_TYPES.has(params.type ?? '') ? (params.type as DetailEntityType) : 'ticket';
      this.entityType.set(type);
      this.entityId.set(params.detail);
    }
  }
}
