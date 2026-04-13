import { Component, DestroyRef, computed, inject, input, output } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Client, ClientService } from '../../../core/services/client.service';
import { AuthService } from '../../../core/services/auth.service';
import { ToastService } from '../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  ToggleSwitchComponent,
  IconComponent,
} from '../../../shared/components/index.js';

@Component({
  selector: 'app-client-header',
  standalone: true,
  imports: [
    RouterLink,
    BroncoButtonComponent,
    IconComponent,
    ToggleSwitchComponent,
  ],
  template: `
    @let c = client();
    <div class="page-header">
      <div class="header-left">
        <app-bronco-button variant="ghost" size="sm" routerLink="/clients"><app-icon name="back" size="sm" /> Clients</app-bronco-button>
        <div class="title-row">
          <h1 class="page-title">{{ c.name }}</h1>
          <span class="chip chip-code">{{ c.shortCode }}</span>
          @if (!c.isActive) {
            <span class="chip chip-inactive">Inactive</span>
          }
        </div>
      </div>
      @if (!isScoped()) {
        <div class="header-right">
          <div class="notif-mode">
            <app-toggle-switch
              [checked]="c.notificationMode === 'operator'"
              label="Operator notification mode"
              (checkedChange)="onNotificationModeChange($event)" />
            <p class="notif-hint">
              Operator mode sends resolution notifications to client staff with ops access.
              Client mode routes them to platform operators.
            </p>
          </div>
        </div>
      }
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
    .header-right {
      display: flex;
      align-items: flex-start;
      justify-content: flex-end;
      padding-top: 6px;
    }
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
    .notif-mode {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      max-width: 320px;
    }
    .notif-hint {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 11px;
      color: var(--text-tertiary);
      line-height: 1.4;
      text-align: right;
    }
  `],
})
export class ClientHeaderComponent {
  client = input.required<Client>();
  clientChange = output<Client>();

  private clientService = inject(ClientService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  isScoped = computed(() => this.auth.isScopedOpsUser());

  onNotificationModeChange(operatorMode: boolean): void {
    const c = this.client();
    const next: 'client' | 'operator' = operatorMode ? 'operator' : 'client';
    if (c.notificationMode === next) return;
    this.clientService
      .updateClient(c.id, { notificationMode: next })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.clientChange.emit({ ...c, ...updated });
          this.toast.success(
            next === 'operator'
              ? 'Notifications now routed to client ops users'
              : 'Notifications now routed to platform operators',
          );
        },
        error: () => this.toast.error('Failed to update notification mode'),
      });
  }
}
