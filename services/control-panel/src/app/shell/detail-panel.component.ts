import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DetailPanelService, DetailEntityType } from '../core/services/detail-panel.service';

const ENTITY_ROUTE_MAP: Record<DetailEntityType, string> = {
  ticket: '/tickets',
  client: '/clients',
  probe: '/scheduled-probes',
  system: '/system-status',
  analysis: '/system-analysis',
  job: '/ingestion-jobs',
};

@Component({
  selector: 'app-detail-panel',
  standalone: true,
  template: `
    <aside class="detail-panel">
      <div class="panel-header">
        <div class="panel-title">
          <span class="entity-type">{{ detailPanel.entityType() }}</span>
          <span class="entity-id">{{ detailPanel.entityId() }}</span>
        </div>
        <div class="panel-actions">
          <button class="panel-btn" (click)="expand()" title="Open full page">
            <span class="material-icons">open_in_full</span>
          </button>
          <button class="panel-btn" (click)="detailPanel.close()" title="Close panel">
            <span class="material-icons">close</span>
          </button>
        </div>
      </div>
      <div class="panel-body">
        <p class="placeholder-text">
          Detail panel content for {{ detailPanel.entityType() }} {{ detailPanel.entityId() }}
        </p>
      </div>
    </aside>
  `,
  styles: [`
    .detail-panel {
      width: var(--detail-panel-width);
      background: var(--bg-panel);
      border-left: 1px solid var(--border-light);
      display: flex;
      flex-direction: column;
      height: 100vh;
      flex-shrink: 0;
      animation: slide-in 200ms ease;
    }

    @keyframes slide-in {
      from {
        width: 0;
        opacity: 0;
      }
      to {
        width: var(--detail-panel-width);
        opacity: 1;
      }
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-light);
      flex-shrink: 0;
    }

    .panel-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .entity-type {
      font-family: var(--font-primary);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
    }

    .entity-id {
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .panel-actions {
      display: flex;
      gap: 4px;
    }

    .panel-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-tertiary);
      transition: background 120ms ease;
    }

    .panel-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .panel-btn .material-icons {
      font-size: 18px;
    }

    .panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }

    .placeholder-text {
      font-family: var(--font-primary);
      font-size: 13px;
      color: var(--text-tertiary);
    }
  `],
})
export class DetailPanelComponent {
  readonly detailPanel = inject(DetailPanelService);
  private readonly router = inject(Router);

  expand(): void {
    const type = this.detailPanel.entityType();
    const id = this.detailPanel.entityId();
    if (type && id) {
      const base = ENTITY_ROUTE_MAP[type] ?? '/';
      this.detailPanel.close();
      this.router.navigate([base, id]);
    }
  }
}
