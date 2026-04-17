import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClientEnvironmentService, type ClientEnvironment } from '../../core/services/client-environment.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, TextareaComponent, ToggleSwitchComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-client-environment-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, ToggleSwitchComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input
          [value]="name"
          placeholder="e.g. Production"
          (valueChange)="name = $event" />
      </app-form-field>

      <app-form-field label="Tag" hint="Lowercase alphanumeric with hyphens only">
        <app-text-input
          [value]="tag"
          placeholder="e.g. production"
          (valueChange)="tag = $event" />
      </app-form-field>

      <app-form-field label="Description">
        <app-textarea
          [value]="description"
          [rows]="2"
          placeholder="Brief description of this environment"
          (valueChange)="description = $event" />
      </app-form-field>

      <app-form-field label="Operational Instructions (Markdown)">
        <app-textarea
          [value]="operationalInstructions"
          [rows]="8"
          placeholder="Instructions injected into AI prompts when analyzing tickets scoped to this environment."
          (valueChange)="operationalInstructions = $event" />
      </app-form-field>

      <div class="row">
        <app-form-field label="Sort Order">
          <app-text-input
            [value]="sortOrder.toString()"
            type="number"
            (valueChange)="sortOrder = parseSortOrder($event)" />
        </app-form-field>
        <div class="toggle-field">
          <app-toggle-switch
            [checked]="isDefault"
            label="Default environment"
            (checkedChange)="isDefault = $event" />
        </div>
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!name.trim() || !tag.trim() || saving" (click)="save()">
        {{ saving ? 'Saving...' : (environment() ? 'Update' : 'Create') }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; align-items: flex-end; gap: 16px; }
    .row app-form-field { flex: 1; }
    .toggle-field { display: flex; align-items: center; padding-bottom: 8px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ClientEnvironmentDialogComponent implements OnInit {
  private envService = inject(ClientEnvironmentService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  environment = input<ClientEnvironment>();

  saved = output<ClientEnvironment>();
  cancelled = output<void>();

  name = '';
  tag = '';
  description = '';
  operationalInstructions = '';
  sortOrder = 0;
  isDefault = false;
  saving = false;

  ngOnInit(): void {
    const env = this.environment();
    if (env) {
      this.name = env.name ?? '';
      this.tag = env.tag ?? '';
      this.description = env.description ?? '';
      this.operationalInstructions = env.operationalInstructions ?? '';
      this.sortOrder = env.sortOrder ?? 0;
      this.isDefault = env.isDefault ?? false;
    }
  }

  parseSortOrder(val: string): number {
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
  }

  save(): void {
    this.saving = true;
    const payload = {
      name: this.name.trim(),
      tag: this.tag.trim(),
      description: this.description.trim() || undefined,
      operationalInstructions: this.operationalInstructions.trim() || undefined,
      sortOrder: this.sortOrder,
      isDefault: this.isDefault,
    };

    const env = this.environment();
    const op = env
      ? this.envService.updateEnvironment(this.clientId(), env.id, payload)
      : this.envService.createEnvironment(this.clientId(), payload);

    op.subscribe({
      next: (result) => {
        this.toast.success(`Environment ${env ? 'updated' : 'created'}`);
        this.saved.emit(result);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? err.error?.message ?? 'Save failed');
      },
    });
  }
}
