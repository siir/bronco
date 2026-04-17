import { Component, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClientService } from '../../core/services/client.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, TextareaComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-client-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input
          [value]="name"
          placeholder="Client name"
          (valueChange)="name = $event" />
      </app-form-field>
      <app-form-field label="Short Code">
        <app-text-input
          [value]="shortCode"
          placeholder="e.g. ACME"
          (valueChange)="shortCode = $event" />
      </app-form-field>
      <app-form-field label="Domain Mappings" hint="Comma-separated email domains to auto-route to this client">
        <app-text-input
          [value]="domainMappingsStr"
          placeholder="e.g. acme.com, acme.org"
          (valueChange)="domainMappingsStr = $event" />
      </app-form-field>
      <app-form-field label="Notes">
        <app-textarea
          [value]="notes"
          [rows]="3"
          (valueChange)="notes = $event" />
      </app-form-field>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!name || !shortCode" (click)="save()">Create</app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ClientDialogComponent {
  private clientService = inject(ClientService);
  private toast = inject(ToastService);

  created = output<boolean>();
  cancelled = output<void>();

  name = '';
  shortCode = '';
  domainMappingsStr = '';
  notes = '';

  save(): void {
    const domainMappings = this.domainMappingsStr
      ? this.domainMappingsStr.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
      : [];
    this.clientService.createClient({
      name: this.name,
      shortCode: this.shortCode,
      domainMappings,
      notes: this.notes || undefined,
    }).subscribe({
      next: () => {
        this.toast.success('Client created');
        this.created.emit(true);
      },
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to create client');
      },
    });
  }
}
