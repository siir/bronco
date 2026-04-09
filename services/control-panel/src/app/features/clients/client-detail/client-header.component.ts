import { Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Client, ClientService } from '../../../core/services/client.service';
import { ToastService } from '../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  ToggleSwitchComponent,
  FormFieldComponent,
  TextInputComponent,
  IconComponent,
} from '../../../shared/components/index.js';

@Component({
  selector: 'app-client-header',
  standalone: true,
  imports: [
    RouterLink,
    BroncoButtonComponent,
    ToggleSwitchComponent,
    FormFieldComponent,
    TextInputComponent,
    IconComponent,
  ],
  template: `
    @let c = client();
    <div class="page-header">
      <div class="header-left">
        <app-bronco-button variant="ghost" size="sm" routerLink="/clients"><app-icon name="back" size="sm" /> Clients</app-bronco-button>
        <div class="title-row">
          <h1 class="page-title">{{ c.name }}</h1>
          <span class="chip chip-code">{{ c.shortCode }}</span>
        </div>
      </div>
      <div class="header-toggles">
        <app-toggle-switch
          [checked]="c.autoRouteTickets"
          [label]="c.autoRouteTickets ? 'Auto-Route' : 'Manual Only'"
          (checkedChange)="toggleAutoRoute()" />
        <app-toggle-switch
          [checked]="c.allowSelfRegistration"
          [label]="c.allowSelfRegistration ? 'Self-Registration' : 'No Self-Reg'"
          (checkedChange)="toggleSelfRegistration()" />
        <app-toggle-switch
          [checked]="c.isActive"
          [label]="c.isActive ? 'Active' : 'Inactive'"
          (checkedChange)="toggleActive()" />
        <app-toggle-switch
          [checked]="c.aiMode === 'byok'"
          [label]="c.aiMode === 'byok' ? 'BYOK' : 'Platform AI'"
          (checkedChange)="toggleAiMode($event)" />
      </div>
    </div>

    @if (c.domainMappings.length) {
      <p class="domains">Domains: {{ c.domainMappings.join(', ') }}</p>
    }
    @if (c.notes) {
      <p class="notes">{{ c.notes }}</p>
    }

    <div class="slack-channel-row">
      <app-form-field label="Slack Channel ID" hint="Right-click channel in Slack → View channel details → scroll to bottom">
        <app-text-input
          [value]="slackInputValue()"
          placeholder="C0AQ0ELLGCV"
          (valueChange)="onSlackInput($event)" />
      </app-form-field>
      <app-bronco-button
        variant="primary"
        size="md"
        [disabled]="pendingSlackChannelId() === null"
        (click)="saveSlackChannelId()">
        Save
      </app-bronco-button>
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
      flex-wrap: wrap;
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
    .header-toggles {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
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

    .domains {
      color: var(--text-secondary);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 13px;
      margin: 0 0 4px;
    }
    .notes {
      color: var(--text-secondary);
      font-family: var(--font-primary);
      font-size: 14px;
      margin: 0 0 16px;
      line-height: 1.5;
    }

    .slack-channel-row {
      display: flex;
      align-items: flex-end;
      gap: 12px;
      margin-bottom: 16px;
    }
    .slack-channel-row app-form-field { flex: 0 0 320px; }
  `],
})
export class ClientHeaderComponent {
  client = input.required<Client>();
  clientChange = output<Client>();

  private clientService = inject(ClientService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  // null = no pending edit; '' = user cleared the field
  pendingSlackChannelId = signal<string | null>(null);

  slackInputValue(): string {
    const pending = this.pendingSlackChannelId();
    if (pending !== null) return pending;
    return this.client().slackChannelId ?? '';
  }

  onSlackInput(value: string): void {
    this.pendingSlackChannelId.set(value);
  }

  toggleActive(): void {
    this.update({ isActive: !this.client().isActive });
  }

  toggleAutoRoute(): void {
    this.update({ autoRouteTickets: !this.client().autoRouteTickets });
  }

  toggleSelfRegistration(): void {
    this.update({ allowSelfRegistration: !this.client().allowSelfRegistration });
  }

  toggleAiMode(byok: boolean): void {
    const mode = byok ? 'byok' : 'platform';
    this.update({ aiMode: mode } as Partial<Client>, `AI mode set to ${mode}`);
  }

  saveSlackChannelId(): void {
    const value = this.pendingSlackChannelId();
    if (value === null) return;
    this.clientService.updateClient(this.client().id, { slackChannelId: value || null } as Partial<Client>)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.pendingSlackChannelId.set(null);
          this.clientChange.emit({ ...this.client(), slackChannelId: updated.slackChannelId });
          this.toast.success('Slack Channel ID saved');
        },
        error: () => this.toast.error('Failed to save Slack Channel ID'),
      });
  }

  private update(patch: Partial<Client>, successToast?: string): void {
    const current = this.client();
    this.clientService.updateClient(current.id, patch)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.clientChange.emit({ ...current, ...updated });
          if (successToast) this.toast.info(successToast);
        },
        error: () => this.toast.error('Update failed'),
      });
  }
}
