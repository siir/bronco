import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { ClientMemoryService, type ClientMemory, MEMORY_TYPE_OPTIONS, CATEGORY_OPTIONS } from '../../core/services/client-memory.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-client-memory-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
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

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!title.trim() || !content.trim() || saving">
        {{ saving ? 'Saving...' : (memory() ? 'Update' : 'Create') }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; }
    .half-width { width: 50%; }
    :host { display: flex; flex-direction: column; min-width: 500px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ClientMemoryDialogComponent implements OnInit {
  private memoryService = inject(ClientMemoryService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  memory = input<ClientMemory>();

  saved = output<ClientMemory>();
  cancelled = output<void>();

  memoryTypes = MEMORY_TYPE_OPTIONS;
  categories = CATEGORY_OPTIONS;

  title = '';
  memoryType = 'CONTEXT';
  category = '';
  tagsInput = '';
  content = '';
  sortOrder = 0;
  saving = false;

  ngOnInit(): void {
    const mem = this.memory();
    if (mem) {
      this.title = mem.title ?? '';
      this.memoryType = mem.memoryType ?? 'CONTEXT';
      this.category = mem.category ?? '';
      this.tagsInput = mem.tags?.join(', ') ?? '';
      this.content = mem.content ?? '';
      this.sortOrder = mem.sortOrder ?? 0;
    }
  }

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

    const mem = this.memory();
    const op = mem
      ? this.memoryService.updateMemory(mem.id, payload)
      : this.memoryService.createMemory({ ...payload, clientId: this.clientId() });

    op.subscribe({
      next: (result) => {
        this.toast.success(`Memory ${mem ? 'updated' : 'created'}`);
        this.saved.emit(result);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.message ?? 'Save failed');
      },
    });
  }
}
