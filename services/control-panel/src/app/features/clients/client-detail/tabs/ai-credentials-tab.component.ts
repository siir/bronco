import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ClientAiCredential, ClientAiCredentialService } from '../../../../core/services/client-ai-credential.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  CardComponent,
  DataTableComponent,
  DataTableColumnComponent,
  FormFieldComponent,
  SelectComponent,
  TextInputComponent,
  ToggleSwitchComponent,
  IconComponent,
} from '../../../../shared/components/index.js';

const PROVIDER_OPTIONS = [
  { value: '', label: 'Select provider' },
  { value: 'CLAUDE', label: 'CLAUDE' },
  { value: 'OPENAI', label: 'OPENAI' },
  { value: 'GROK', label: 'GROK' },
];

@Component({
  selector: 'app-client-ai-credentials-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    CardComponent,
    DataTableComponent,
    DataTableColumnComponent,
    FormFieldComponent,
    SelectComponent,
    TextInputComponent,
    ToggleSwitchComponent,
    IconComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">AI Credentials (BYOK)</h3>
      </div>

      <app-data-table
        [data]="credentials()"
        [trackBy]="trackById"
        [rowClickable]="false"
        emptyMessage="No AI credentials configured. Add credentials to use BYOK mode.">
        <app-data-column key="provider" header="Provider" [sortable]="false">
          <ng-template #cell let-cred>
            <span class="chip chip-provider">{{ cred.provider }}</span>
          </ng-template>
        </app-data-column>
        <app-data-column key="label" header="Label" [sortable]="false">
          <ng-template #cell let-cred>{{ cred.label }}</ng-template>
        </app-data-column>
        <app-data-column key="key" header="API Key" [sortable]="false" width="120px">
          <ng-template #cell let-cred>
            <code class="key-mask">…{{ cred.last4 }}</code>
          </ng-template>
        </app-data-column>
        <app-data-column key="credStatus" header="Status" [sortable]="false" width="140px">
          <ng-template #cell let-cred>
            <app-toggle-switch
              [checked]="cred.isActive"
              [label]="cred.isActive ? 'Active' : 'Inactive'"
              (checkedChange)="toggleCredential(cred, $event)" />
          </ng-template>
        </app-data-column>
        <app-data-column key="credActions" header="" [sortable]="false" width="100px">
          <ng-template #cell let-cred>
            <div class="row-actions">
              <app-bronco-button variant="icon" size="sm" ariaLabel="Test credential" (click)="testCredential(cred)"><app-icon name="play" size="sm" /></app-bronco-button>
              <app-bronco-button variant="icon" size="sm" ariaLabel="Delete credential" (click)="deleteCredential(cred)"><app-icon name="delete" size="sm" /></app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>
      </app-data-table>

      <app-card padding="md" class="add-cred-card">
        <h4 class="add-cred-title">Add Credential</h4>
        <div class="cred-form">
          <app-form-field label="Provider">
            <app-select
              [value]="newProvider()"
              [options]="providerOptions"
              placeholder="Select provider"
              (valueChange)="newProvider.set($event)" />
          </app-form-field>
          <app-form-field label="Label">
            <app-text-input
              [value]="newLabel()"
              placeholder="e.g. Production Key"
              (valueChange)="newLabel.set($event)" />
          </app-form-field>
          <app-form-field label="API Key">
            <app-text-input
              type="password"
              [value]="newApiKey()"
              placeholder="sk-..."
              (valueChange)="newApiKey.set($event)" />
          </app-form-field>
          <div class="add-cred-action">
            <app-bronco-button
              variant="primary"
              size="md"
              [disabled]="!canAdd()"
              (click)="addCredential()">+ Add</app-bronco-button>
          </div>
        </div>
      </app-card>
    </div>
  `,
  styles: [`
    :host { display: block; }

    .tab-section { padding: 16px 0; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
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

    .chip-provider {
      background: var(--color-purple-subtle);
      color: var(--color-purple);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    }

    .key-mask {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-code);
      padding: 1px 6px;
      border-radius: var(--radius-sm);
    }

    .row-actions {
      display: inline-flex;
      gap: 4px;
    }

    .add-cred-card {
      margin-top: 16px;
    }

    .add-cred-title {
      margin: 0 0 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .cred-form {
      display: grid;
      grid-template-columns: 1fr 1fr 2fr auto;
      gap: 12px;
      align-items: end;
    }

    .add-cred-action {
      display: flex;
      align-items: end;
    }

    @media (max-width: 720px) {
      .cred-form {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class ClientAiCredentialsTabComponent implements OnInit {
  clientId = input.required<string>();

  private credentialService = inject(ClientAiCredentialService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  credentials = signal<ClientAiCredential[]>([]);
  newProvider = signal('');
  newLabel = signal('');
  newApiKey = signal('');

  readonly providerOptions = PROVIDER_OPTIONS;

  trackById = (c: ClientAiCredential): string => c.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.credentialService.getCredentials(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(c => this.credentials.set(c));
  }

  canAdd(): boolean {
    return !!this.newProvider() && !!this.newLabel() && !!this.newApiKey();
  }

  addCredential(): void {
    this.credentialService.createCredential(this.clientId(), {
      provider: this.newProvider(),
      apiKey: this.newApiKey(),
      label: this.newLabel(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.newProvider.set('');
          this.newLabel.set('');
          this.newApiKey.set('');
          this.toast.success('Credential added');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Failed to add credential'),
      });
  }

  toggleCredential(cred: ClientAiCredential, checked: boolean): void {
    this.credentials.update(list => list.map(c => c.id === cred.id ? { ...c, isActive: checked } : c));
    this.credentialService.updateCredential(this.clientId(), cred.id, { isActive: checked })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.toast.success(`Credential ${checked ? 'enabled' : 'disabled'}`),
        error: (err) => {
          this.credentials.update(list => list.map(c => c.id === cred.id ? { ...c, isActive: !checked } : c));
          this.toast.error(err.error?.error ?? 'Toggle failed');
        },
      });
  }

  testCredential(cred: ClientAiCredential): void {
    this.toast.info('Testing credential...');
    this.credentialService.testCredential(this.clientId(), cred.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => result.ok ? this.toast.success('Credential is valid') : this.toast.error(`Test failed: ${result.error}`),
        error: (err) => this.toast.error(err.error?.error ?? 'Test failed'),
      });
  }

  deleteCredential(cred: ClientAiCredential): void {
    if (!confirm(`Delete credential "${cred.label}"?`)) return;
    this.credentialService.deleteCredential(this.clientId(), cred.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Credential deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Delete failed'),
      });
  }
}
