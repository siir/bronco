import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DetailPanelService, DetailEntityType } from '../core/services/detail-panel.service';

/** Returns the route segments for a given entity type and id. */
function entityRoute(type: DetailEntityType, id: string): string[] {
  switch (type) {
    case 'ticket': return ['/tickets', id];
    case 'client': return ['/clients', id];
    case 'probe': return ['/scheduled-probes', id, 'runs'];
    case 'system': return ['/system-status'];
    case 'analysis': return ['/system-analysis'];
    case 'job': return ['/ingestion-jobs'];
  }
}

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
          <button class="panel-btn" (click)="expandToFullPage()" title="Open full page" aria-label="Open full page">
            <span class="expand-icon">&#x2197;</span>
          </button>
          <button class="panel-btn" (click)="detailPanel.close()" title="Close panel" aria-label="Close panel">
            <span class="close-icon">&times;</span>
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
      min-width: var(--detail-panel-width);
      height: 100vh;
      background: var(--bg-panel);
      border-left: 1px solid var(--border-light);
      display: flex;
      flex-direction: column;
      font-family: var(--font-primary);
      animation: slide-in 200ms ease;
    }
    @keyframes slide-in {
      from {
        width: 0;
        min-width: 0;
        opacity: 0;
      }
      to {
        width: var(--detail-panel-width);
        min-width: var(--detail-panel-width);
        opacity: 1;
      }
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-light);
      min-height: var(--header-height);
    }
    .panel-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .entity-type {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
    }
    .entity-id {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }
    .panel-actions {
      display: flex;
      gap: 4px;
    }
    .panel-btn {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-tertiary);
      font-size: 16px;
      transition: background 120ms ease;
    }
    .panel-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
    .expand-icon {
      font-size: 14px;
    }
    .close-icon {
      font-size: 20px;
      line-height: 1;
    }
    .panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    .placeholder-text {
      font-size: 13px;
      color: var(--text-tertiary);
    }
  `],
})
export class DetailPanelComponent {
  readonly detailPanel = inject(DetailPanelService);
  private readonly router = inject(Router);

  expandToFullPage(): void {
    const type = this.detailPanel.entityType();
    const id = this.detailPanel.entityId();
    if (type && id) {
      this.detailPanel.close();
      this.router.navigate(entityRoute(type, id));
    }
  }
}
