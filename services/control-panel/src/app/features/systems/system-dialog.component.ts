import { Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { SystemService } from '../../core/services/system.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-system-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatCheckboxModule],
  template: `
    <div class="row">
      <mat-form-field class="flex">
        <mat-label>Name</mat-label>
        <input matInput [(ngModel)]="form.name" required>
      </mat-form-field>
      <mat-form-field class="flex">
        <mat-label>Engine</mat-label>
        <mat-select [(ngModel)]="form.dbEngine">
          <mat-option value="MSSQL">MSSQL</mat-option>
          <mat-option value="AZURE_SQL_MI">Azure SQL MI</mat-option>
          <mat-option value="POSTGRESQL">PostgreSQL</mat-option>
          <mat-option value="MYSQL">MySQL</mat-option>
        </mat-select>
      </mat-form-field>
    </div>
    <div class="row">
      <mat-form-field class="flex">
        <mat-label>Host</mat-label>
        <input matInput [(ngModel)]="form.host" required>
      </mat-form-field>
      <mat-form-field style="width: 120px">
        <mat-label>Port</mat-label>
        <input matInput type="number" [(ngModel)]="form.port" min="1" max="65535">
      </mat-form-field>
    </div>
    <div class="row">
      <mat-form-field class="flex">
        <mat-label>Username</mat-label>
        <input matInput [(ngModel)]="form.username">
      </mat-form-field>
      <mat-form-field class="flex">
        <mat-label>Default Database</mat-label>
        <input matInput [(ngModel)]="form.defaultDatabase">
      </mat-form-field>
    </div>
    <div class="row">
      <mat-form-field class="flex">
        <mat-label>Environment</mat-label>
        <mat-select [(ngModel)]="form.environment">
          <mat-option value="PRODUCTION">Production</mat-option>
          <mat-option value="STAGING">Staging</mat-option>
          <mat-option value="DEVELOPMENT">Development</mat-option>
          <mat-option value="DR">DR</mat-option>
        </mat-select>
      </mat-form-field>
      <mat-form-field class="flex">
        <mat-label>Auth Method</mat-label>
        <mat-select [(ngModel)]="form.authMethod">
          <mat-option value="SQL_AUTH">SQL Auth</mat-option>
          <mat-option value="WINDOWS_AUTH">Windows Auth</mat-option>
          <mat-option value="AZURE_AD">Azure AD</mat-option>
        </mat-select>
      </mat-form-field>
    </div>
    <mat-form-field class="full-width">
      <mat-label>Notes</mat-label>
      <textarea matInput [(ngModel)]="form.notes" rows="2"></textarea>
    </mat-form-field>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!form.name || !form.host || form.port < 1 || form.port > 65535">Create</button>
    </div>
  `,
  styles: [`
    .row { display: flex; gap: 12px; }
    .flex { flex: 1; }
    .full-width { width: 100%; }
    mat-form-field { margin-bottom: 4px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class SystemDialogComponent {
  private systemService = inject(SystemService);
  private toast = inject(ToastService);

  clientId = input.required<string>();

  saved = output<boolean>();
  cancelled = output<void>();

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

  save(): void {
    this.systemService.createSystem({
      clientId: this.clientId(),
      name: this.form.name,
      host: this.form.host,
      port: this.form.port,
      dbEngine: this.form.dbEngine,
      username: this.form.username || undefined,
      defaultDatabase: this.form.defaultDatabase || undefined,
      environment: this.form.environment,
      authMethod: this.form.authMethod,
      notes: this.form.notes || undefined,
    } as never).subscribe({
      next: () => {
        this.toast.success('System created');
        this.saved.emit(true);
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Failed'),
    });
  }
}
