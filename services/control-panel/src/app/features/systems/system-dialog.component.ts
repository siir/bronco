import { Component, inject, input, OnInit, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SystemService } from '../../core/services/system.service';
import { System } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-system-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <div class="row">
        <app-form-field label="Name">
          <app-text-input
            [value]="form.name"
            (valueChange)="form.name = $event" />
        </app-form-field>
        <app-form-field label="Engine">
          <app-select
            [value]="form.dbEngine"
            [options]="engineOptions"
            (valueChange)="form.dbEngine = $event" />
        </app-form-field>
      </div>
      <div class="row">
        <app-form-field label="Host">
          <app-text-input
            [value]="form.host"
            (valueChange)="form.host = $event" />
        </app-form-field>
        <div class="port-field">
          <app-form-field label="Port">
            <app-text-input
              [value]="form.port.toString()"
              type="number"
              (valueChange)="form.port = +$event" />
          </app-form-field>
        </div>
      </div>
      <div class="row">
        <app-form-field label="Username">
          <app-text-input
            [value]="form.username"
            (valueChange)="form.username = $event" />
        </app-form-field>
        <app-form-field label="Default Database">
          <app-text-input
            [value]="form.defaultDatabase"
            (valueChange)="form.defaultDatabase = $event" />
        </app-form-field>
      </div>
      <div class="row">
        <app-form-field label="Environment">
          <app-select
            [value]="form.environment"
            [options]="environmentOptions"
            (valueChange)="form.environment = $event" />
        </app-form-field>
        <app-form-field label="Auth Method">
          <app-select
            [value]="form.authMethod"
            [options]="authMethodOptions"
            (valueChange)="form.authMethod = $event" />
        </app-form-field>
      </div>
      <app-form-field label="Notes">
        <app-textarea
          [value]="form.notes"
          [rows]="2"
          (valueChange)="form.notes = $event" />
      </app-form-field>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!form.name || !form.host || form.port < 1 || form.port > 65535" (click)="save()">
        {{ editing ? 'Save' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; gap: 12px; }
    .row app-form-field { flex: 1; }
    .port-field { width: 120px; flex-shrink: 0; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

    @media (max-width: 767.98px) {
      .row { flex-direction: column; gap: 12px; }
      .port-field { width: 100%; }
    }
  `],
})
export class SystemDialogComponent implements OnInit {
  private systemService = inject(SystemService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  system = input<System | undefined>(undefined);

  saved = output<boolean>();
  cancelled = output<void>();

  editing = false;

  engineOptions = [
    { value: 'MSSQL', label: 'MSSQL' },
    { value: 'AZURE_SQL_MI', label: 'Azure SQL MI' },
    { value: 'POSTGRESQL', label: 'PostgreSQL' },
    { value: 'MYSQL', label: 'MySQL' },
  ];

  environmentOptions = [
    { value: 'PRODUCTION', label: 'Production' },
    { value: 'STAGING', label: 'Staging' },
    { value: 'DEVELOPMENT', label: 'Development' },
    { value: 'DR', label: 'DR' },
  ];

  authMethodOptions = [
    { value: 'SQL_AUTH', label: 'SQL Auth' },
    { value: 'WINDOWS_AUTH', label: 'Windows Auth' },
    { value: 'AZURE_AD', label: 'Azure AD' },
  ];

  form = {
    name: '',
    dbEngine: 'MSSQL',
    host: '',
    port: 1433,
    username: '',
    defaultDatabase: '',
    environment: 'PRODUCTION',
    authMethod: 'SQL_AUTH',
    notes: '',
  };

  ngOnInit(): void {
    const sys = this.system();
    if (sys) {
      this.editing = true;
      this.form = {
        name: sys.name,
        dbEngine: sys.dbEngine,
        host: sys.host,
        port: sys.port,
        username: sys.username ?? '',
        defaultDatabase: sys.defaultDatabase ?? '',
        environment: sys.environment,
        authMethod: sys.authMethod,
        notes: sys.notes ?? '',
      };
    }
  }

  save(): void {
    const payload = {
      name: this.form.name,
      host: this.form.host,
      port: this.form.port,
      dbEngine: this.form.dbEngine,
      username: this.form.username || undefined,
      defaultDatabase: this.form.defaultDatabase || undefined,
      environment: this.form.environment,
      authMethod: this.form.authMethod,
      notes: this.form.notes || undefined,
    };

    const sys = this.system();
    if (this.editing && sys) {
      this.systemService.updateSystem(sys.id, payload as never).subscribe({
        next: () => {
          this.toast.success('System updated');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Update failed'),
      });
    } else {
      this.systemService.createSystem({
        clientId: this.clientId(),
        ...payload,
      } as never).subscribe({
        next: () => {
          this.toast.success('System created');
          this.saved.emit(true);
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Failed'),
      });
    }
  }
}
