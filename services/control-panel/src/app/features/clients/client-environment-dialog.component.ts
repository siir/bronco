import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { ClientEnvironmentService, type ClientEnvironment } from '../../core/services/client-environment.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-client-environment-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCheckboxModule],
  template: `
    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="name" placeholder="e.g. Production">
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Tag</mat-label>
      <input matInput [(ngModel)]="tag" placeholder="e.g. production">
      <mat-hint>Lowercase alphanumeric with hyphens only</mat-hint>
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Description</mat-label>
      <textarea matInput [(ngModel)]="description" rows="2" placeholder="Brief description of this environment"></textarea>
    </mat-form-field>

    <mat-form-field appearance="outline" class="full-width">
      <mat-label>Operational Instructions (Markdown)</mat-label>
      <textarea matInput [(ngModel)]="operationalInstructions" rows="8"
        placeholder="Instructions injected into AI prompts when analyzing tickets scoped to this environment."></textarea>
    </mat-form-field>

    <div class="row">
      <mat-form-field appearance="outline" class="half-width">
        <mat-label>Sort Order</mat-label>
        <input matInput type="number" [(ngModel)]="sortOrder">
      </mat-form-field>
      <mat-checkbox [(ngModel)]="isDefault">Default environment</mat-checkbox>
    </div>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name.trim() || !tag.trim() || saving">
        {{ saving ? 'Saving...' : (environment() ? 'Update' : 'Create') }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; }
    .half-width { width: 50%; }
    .row { display: flex; align-items: center; gap: 16px; }
    :host { display: flex; flex-direction: column; min-width: 500px; }
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
