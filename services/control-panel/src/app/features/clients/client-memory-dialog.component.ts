import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ClientMemoryService, type ClientMemory, MEMORY_TYPE_OPTIONS, CATEGORY_OPTIONS } from '../../core/services/client-memory.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.memory ? 'Edit' : 'Add' }} Client Memory</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Title</mat-label>
        <input matInput [(ngModel)]="title" placeholder="e.g. Blocking Sessions Playbook">
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Memory Type</mat-label>
        <mat-select [(ngModel)]="memoryType">
          @for (mt of memoryTypes; track mt.value) {
            <mat-option [value]="mt.value">{{ mt.label }} — {{ mt.description }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Category Scope</mat-label>
        <mat-select [(ngModel)]="category">
          @for (cat of categories; track cat.value) {
            <mat-option [value]="cat.value">{{ cat.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Tags (comma-separated)</mat-label>
        <input matInput [(ngModel)]="tagsInput" placeholder="blocking, deadlocks, azure-sql">
      </mat-form-field>

      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Content (Markdown)</mat-label>
        <textarea matInput [(ngModel)]="content" rows="12"
          placeholder="Write operational knowledge here. This will be injected into AI prompts when analyzing tickets for this client."></textarea>
      </mat-form-field>

      <mat-form-field appearance="outline" class="half-width">
        <mat-label>Sort Order</mat-label>
        <input matInput type="number" [(ngModel)]="sortOrder">
      </mat-form-field>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!title.trim() || !content.trim() || saving">
        {{ saving ? 'Saving...' : (data.memory ? 'Update' : 'Create') }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; }
    .half-width { width: 50%; }
    mat-dialog-content { display: flex; flex-direction: column; min-width: 500px; }
  `],
})
export class ClientMemoryDialogComponent {
  private dialogRef = inject(MatDialogRef<ClientMemoryDialogComponent>);
  data = inject<{ clientId: string; memory?: ClientMemory }>(MAT_DIALOG_DATA);
  private memoryService = inject(ClientMemoryService);
  private snackBar = inject(MatSnackBar);

  memoryTypes = MEMORY_TYPE_OPTIONS;
  categories = CATEGORY_OPTIONS;

  title = this.data.memory?.title ?? '';
  memoryType = this.data.memory?.memoryType ?? 'CONTEXT';
  category = this.data.memory?.category ?? '';
  tagsInput = this.data.memory?.tags?.join(', ') ?? '';
  content = this.data.memory?.content ?? '';
  sortOrder = this.data.memory?.sortOrder ?? 0;
  saving = false;

  save(): void {
    this.saving = true;
    const tags = this.tagsInput.split(',').map(t => t.trim()).filter(Boolean);
    const payload = {
      title: this.title.trim(),
      memoryType: this.memoryType,
      category: this.category || null,
      tags,
      content: this.content.trim(),
      sortOrder: this.sortOrder,
    };

    const op = this.data.memory
      ? this.memoryService.updateMemory(this.data.memory.id, payload)
      : this.memoryService.createMemory({ ...payload, clientId: this.data.clientId });

    op.subscribe({
      next: (result) => {
        this.snackBar.open(`Memory ${this.data.memory ? 'updated' : 'created'}`, 'OK', { duration: 3000 });
        this.dialogRef.close(result);
      },
      error: (err) => {
        this.saving = false;
        this.snackBar.open(err.error?.message ?? 'Save failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' });
      },
    });
  }
}
