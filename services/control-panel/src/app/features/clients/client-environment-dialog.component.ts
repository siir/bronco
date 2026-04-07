import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { ClientEnvironmentService, type ClientEnvironment } from '../../core/services/client-environment.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ data.environment ? 'Edit' : 'Add' }} Environment</h2>
    <mat-dialog-content>
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
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!name.trim() || !tag.trim() || saving">
        {{ saving ? 'Saving...' : (data.environment ? 'Update' : 'Create') }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; }
    .half-width { width: 50%; }
    .row { display: flex; align-items: center; gap: 16px; }
    mat-dialog-content { display: flex; flex-direction: column; min-width: 500px; }
  `],
})
export class ClientEnvironmentDialogComponent {
  private dialogRef = inject(MatDialogRef<ClientEnvironmentDialogComponent>);
  data = inject<{ clientId: string; environment?: ClientEnvironment }>(MAT_DIALOG_DATA);
  private envService = inject(ClientEnvironmentService);
  private toast = inject(ToastService);

  name = this.data.environment?.name ?? '';
  tag = this.data.environment?.tag ?? '';
  description = this.data.environment?.description ?? '';
  operationalInstructions = this.data.environment?.operationalInstructions ?? '';
  sortOrder = this.data.environment?.sortOrder ?? 0;
  isDefault = this.data.environment?.isDefault ?? false;
  saving = false;

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

    const op = this.data.environment
      ? this.envService.updateEnvironment(this.data.clientId, this.data.environment.id, payload)
      : this.envService.createEnvironment(this.data.clientId, payload);

    op.subscribe({
      next: (result) => {
        this.toast.success(`Environment ${this.data.environment ? 'updated' : 'created'}`);
        this.dialogRef.close(result);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? err.error?.message ?? 'Save failed');
      },
    });
  }
}
