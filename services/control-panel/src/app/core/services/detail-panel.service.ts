import { Injectable, signal, computed, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';

export type DetailEntityType = 'ticket' | 'client' | 'probe' | 'system' | 'analysis' | 'job';

@Injectable({ providedIn: 'root' })
export class DetailPanelService {
  private readonly location = inject(Location);
  private readonly router = inject(Router);

  readonly entityType = signal<DetailEntityType | null>(null);
  readonly entityId = signal<string | null>(null);
  readonly isOpen = computed(() => this.entityId() !== null);

  open(type: DetailEntityType, id: string): void {
    this.entityType.set(type);
    this.entityId.set(id);
    const url = this.router.url.split('?')[0];
    this.location.replaceState(url, `detail=${id}`);
  }

  close(): void {
    this.entityType.set(null);
    this.entityId.set(null);
    const url = this.router.url.split('?')[0];
    this.location.replaceState(url);
  }

  /** Call from shell on init to restore panel from query param */
  restoreFromUrl(params: { detail?: string; type?: string }): void {
    if (params.detail) {
      this.entityType.set((params.type as DetailEntityType) ?? 'ticket');
      this.entityId.set(params.detail);
    }
  }
}
