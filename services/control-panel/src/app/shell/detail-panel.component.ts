import { Component, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DatePipe } from '@angular/common';
import { DetailPanelService, DetailEntityType } from '../core/services/detail-panel.service';
import { TicketService, Ticket } from '../core/services/ticket.service';
import {
  StatusBadgeComponent,
  PriorityPillComponent,
  CategoryChipComponent,
  TabComponent,
  TabGroupComponent,
} from '../shared/components/index.js';

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
  imports: [
    DatePipe,
    StatusBadgeComponent,
    PriorityPillComponent,
    CategoryChipComponent,
    TabComponent,
    TabGroupComponent,
  ],
  template: `
    <aside class="detail-panel">
      <div class="panel-header">
        @if (ticket(); as t) {
          <div class="panel-title">
            <span class="entity-type">Ticket</span>
            <span class="entity-subject">{{ t.subject }}</span>
          </div>
        } @else {
          <div class="panel-title">
            <span class="entity-type">{{ detailPanel.entityType() }}</span>
            <span class="entity-id">{{ detailPanel.entityId() }}</span>
          </div>
        }
        <div class="panel-actions">
          <button class="panel-btn" (click)="expandToFullPage()" title="Open full page" aria-label="Open full page">
            <span class="expand-icon">&#x2197;</span>
          </button>
          <button class="panel-btn" (click)="detailPanel.close()" title="Close panel" aria-label="Close panel">
            <span class="close-icon">&times;</span>
          </button>
        </div>
      </div>

      @if (loading()) {
        <div class="panel-loading">Loading...</div>
      } @else if (ticket(); as t) {
        <div class="panel-meta">
          <app-status-badge [status]="mapStatus(t.status)" />
          <app-priority-pill [priority]="$any(t.priority)" />
          @if (t.category) {
            <app-category-chip [category]="t.category" />
          }
        </div>

        <app-tab-group [selectedIndex]="selectedTab()" (selectedIndexChange)="selectedTab.set($event)">
          <app-tab label="Details">
            <div class="detail-fields">
              <div class="field-row">
                <span class="field-label">Client</span>
                <span class="field-value">
                  @if (t.client; as c) {
                    @if (c.shortCode) {
                      <span class="client-code">{{ c.shortCode }}</span>
                    }
                  }
                  {{ t.client?.name ?? '—' }}
                </span>
              </div>
              <div class="field-row">
                <span class="field-label">System</span>
                <span class="field-value">{{ t.system?.name ?? '—' }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Source</span>
                <span class="field-value">{{ t.source }}</span>
              </div>
              <div class="field-row">
                <span class="field-label">Created</span>
                <span class="field-value">{{ t.createdAt | date:'medium' }}</span>
              </div>
              @if (t.resolvedAt) {
                <div class="field-row">
                  <span class="field-label">Resolved</span>
                  <span class="field-value">{{ t.resolvedAt | date:'medium' }}</span>
                </div>
              }
            </div>
            @if (t.summary) {
              <div class="detail-section">
                <span class="section-label">Summary</span>
                <p class="summary-text">{{ t.summary }}</p>
              </div>
            }
          </app-tab>
          <app-tab label="Events">
            <p class="placeholder-text">Events view coming soon</p>
          </app-tab>
        </app-tab-group>
      } @else {
        <div class="panel-body">
          <p class="placeholder-text">
            Detail panel content for {{ detailPanel.entityType() }} {{ detailPanel.entityId() }}
          </p>
        </div>
      }
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
    .entity-subject {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      line-height: 1.3;
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

    .panel-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-light);
      align-items: center;
    }

    .panel-loading {
      padding: 48px 16px;
      text-align: center;
      font-size: 13px;
      color: var(--text-tertiary);
    }

    .detail-fields {
      padding: 4px 0;
    }

    .field-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
    }

    .field-label {
      font-size: 13px;
      color: var(--text-tertiary);
    }

    .field-value {
      font-size: 13px;
      color: var(--text-primary);
      font-weight: 500;
    }

    .client-code {
      color: var(--accent);
      font-weight: 600;
    }

    .detail-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-light);
    }

    .section-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }

    .summary-text {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.6;
      margin: 0;
    }
  `],
})
export class DetailPanelComponent {
  readonly detailPanel = inject(DetailPanelService);
  private readonly router = inject(Router);
  private readonly ticketService = inject(TicketService);

  ticket = signal<Ticket | null>(null);
  selectedTab = signal(0);
  loading = signal(false);

  constructor() {
    effect(() => {
      const type = this.detailPanel.entityType();
      const id = this.detailPanel.entityId();
      if (type === 'ticket' && id) {
        this.loadTicket(id);
      } else {
        this.ticket.set(null);
      }
    });
  }

  expandToFullPage(): void {
    const type = this.detailPanel.entityType();
    const id = this.detailPanel.entityId();
    if (type && id) {
      this.detailPanel.close();
      this.router.navigate(entityRoute(type, id));
    }
  }

  /** Map API ticket status strings to StatusBadge values */
  mapStatus(status: string): 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed' {
    const map: Record<string, 'open' | 'in_progress' | 'analyzing' | 'resolved' | 'closed'> = {
      OPEN: 'open',
      IN_PROGRESS: 'in_progress',
      ANALYZING: 'analyzing',
      RESOLVED: 'resolved',
      CLOSED: 'closed',
    };
    return map[status] ?? 'open';
  }

  private loadTicket(id: string): void {
    this.loading.set(true);
    this.ticketService.getTicket(id).subscribe({
      next: (t) => { this.ticket.set(t); this.loading.set(false); },
      error: () => { this.ticket.set(null); this.loading.set(false); },
    });
  }
}
