import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Client } from '../../../core/services/client.service';
import {
  BroncoButtonComponent,
} from '../../../shared/components/index.js';

@Component({
  selector: 'app-client-header',
  standalone: true,
  imports: [
    RouterLink,
    BroncoButtonComponent,
  ],
  template: `
    @let c = client();
    <div class="page-header">
      <div class="header-left">
        <app-bronco-button variant="ghost" size="sm" routerLink="/clients">&#x2190; Clients</app-bronco-button>
        <div class="title-row">
          <h1 class="page-title">{{ c.name }}</h1>
          <span class="chip chip-code">{{ c.shortCode }}</span>
          @if (!c.isActive) {
            <span class="chip chip-inactive">Inactive</span>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }

    .page-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 16px;
    }
    .header-left { display: flex; flex-direction: column; gap: 4px; }
    .title-row { display: flex; align-items: center; gap: 10px; }
    .page-title {
      margin: 6px 0 0;
      font-family: var(--font-primary);
      font-size: 24px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.24px;
      line-height: 1.2;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
      white-space: nowrap;
    }
    .chip-code {
      background: var(--bg-active);
      color: var(--accent);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
    }
    .chip-inactive {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }
  `],
})
export class ClientHeaderComponent {
  client = input.required<Client>();
}
