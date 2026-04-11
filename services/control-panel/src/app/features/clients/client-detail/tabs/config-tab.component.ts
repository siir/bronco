import { Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Client, ClientService } from '../../../../core/services/client.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  ToggleSwitchComponent,
  FormFieldComponent,
  TextInputComponent,
  TextareaComponent,
} from '../../../../shared/components/index.js';

@Component({
  selector: 'app-client-config-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    ToggleSwitchComponent,
    FormFieldComponent,
    TextInputComponent,
    TextareaComponent,
  ],
  template: `
    @if (client(); as c) {
      <div class="config-sections">
        <div class="config-section">
          <h3 class="section-title">Routing &amp; Access</h3>
          <div class="toggle-list">
            <app-toggle-switch
              [checked]="c.isActive"
              label="Active"
              (checkedChange)="toggle('isActive', $event)" />
            <app-toggle-switch
              [checked]="c.autoRouteTickets"
              label="Auto-route tickets"
              (checkedChange)="toggle('autoRouteTickets', $event)" />
            <app-toggle-switch
              [checked]="c.allowSelfRegistration"
              label="Allow self-registration"
              (checkedChange)="toggle('allowSelfRegistration', $event)" />
          </div>
        </div>

        <div class="config-section">
          <h3 class="section-title">AI</h3>
          <div class="toggle-list">
            <app-toggle-switch
              [checked]="c.aiMode === 'byok'"
              label="BYOK mode (client provides own API keys)"
              (checkedChange)="toggleAiMode($event)" />
          </div>
        </div>

        <div class="config-section">
          <h3 class="section-title">Slack Integration</h3>
          <div class="field-group">
            <app-form-field label="Channel ID" hint="Right-click channel in Slack → View channel details → scroll to bottom">
              <app-text-input
                [value]="slackValue()"
                placeholder="C0AQ0ELLGCV"
                (valueChange)="slackValue.set($event)" />
            </app-form-field>
            <app-bronco-button
              variant="primary"
              size="sm"
              [disabled]="slackValue() === (c.slackChannelId ?? '')"
              (click)="saveSlack()">
              Save
            </app-bronco-button>
          </div>
        </div>

        <div class="config-section">
          <h3 class="section-title">Domains</h3>
          <app-form-field label="Domain Mappings" hint="Comma-separated list of email domains for this client">
            <app-text-input
              [value]="domainsValue()"
              placeholder="example.com, example.org"
              (valueChange)="domainsValue.set($event)" />
          </app-form-field>
          <app-bronco-button
            variant="primary"
            size="sm"
            [disabled]="domainsValue() === (c.domainMappings).join(', ')"
            (click)="saveDomains()">
            Save
          </app-bronco-button>
        </div>

        <div class="config-section">
          <h3 class="section-title">Notes</h3>
          <app-form-field label="Internal Notes">
            <app-textarea
              [value]="notesValue()"
              [rows]="3"
              placeholder="Internal notes about this client..."
              (valueChange)="notesValue.set($event)" />
          </app-form-field>
          <app-bronco-button
            variant="primary"
            size="sm"
            [disabled]="notesValue() === (c.notes ?? '')"
            (click)="saveNotes()">
            Save
          </app-bronco-button>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .config-sections { padding: 16px 0; display: flex; flex-direction: column; gap: 24px; }
    .config-section { display: flex; flex-direction: column; gap: 10px; }
    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      padding-bottom: 6px;
      border-bottom: 1px solid var(--border-light);
    }
    .toggle-list { display: flex; flex-direction: column; gap: 8px; }
    .field-group {
      display: flex;
      align-items: flex-end;
      gap: 10px;
    }
    .field-group app-form-field { flex: 0 0 320px; }
  `],
})
export class ClientConfigTabComponent {
  client = input.required<Client>();
  clientChange = output<Client>();

  private clientService = inject(ClientService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  slackValue = signal('');
  domainsValue = signal('');
  notesValue = signal('');
  private initialized = false;

  ngOnChanges(): void {
    const c = this.client();
    if (c && !this.initialized) {
      this.initialized = true;
      this.slackValue.set(c.slackChannelId ?? '');
      this.domainsValue.set((c.domainMappings).join(', '));
      this.notesValue.set(c.notes ?? '');
    }
  }

  toggle(field: 'isActive' | 'autoRouteTickets' | 'allowSelfRegistration', value: boolean): void {
    this.patch({ [field]: value });
  }

  toggleAiMode(byok: boolean): void {
    this.patch({ aiMode: byok ? 'byok' : 'platform' } as Partial<Client>);
  }

  saveSlack(): void {
    this.patch({ slackChannelId: this.slackValue() || null } as Partial<Client>, 'Slack Channel ID saved');
  }

  saveDomains(): void {
    const domains = this.domainsValue()
      .split(',')
      .map(d => d.trim())
      .filter(Boolean);
    this.patch({ domainMappings: domains } as Partial<Client>, 'Domains saved');
  }

  saveNotes(): void {
    this.patch({ notes: this.notesValue() || null } as Partial<Client>, 'Notes saved');
  }

  private patch(data: Partial<Client>, successMsg?: string): void {
    const c = this.client();
    this.clientService.updateClient(c.id, data)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.clientChange.emit({ ...c, ...updated });
          if (successMsg) this.toast.success(successMsg);
        },
        error: () => this.toast.error('Update failed'),
      });
  }
}
