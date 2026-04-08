import { Component, inject, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClientMemoryService, type ClientMemory, MEMORY_TYPE_OPTIONS, CATEGORY_OPTIONS } from '../../core/services/client-memory.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-client-memory-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Title">
        <app-text-input
          [value]="title"
          placeholder="e.g. Blocking Sessions Playbook"
          (valueChange)="title = $event" />
      </app-form-field>

      <app-form-field label="Memory Type">
        <app-select
          [value]="memoryType"
          [options]="memoryTypeOptions"
          (valueChange)="memoryType = $event" />
      </app-form-field>

      <app-form-field label="Category Scope">
        <app-select
          [value]="category"
          [options]="categoryOptions"
          (valueChange)="category = $event" />
      </app-form-field>

      <app-form-field label="Tags (comma-separated)">
        <app-text-input
          [value]="tagsInput"
          placeholder="blocking, deadlocks, azure-sql"
          (valueChange)="tagsInput = $event" />
      </app-form-field>

      <app-form-field label="Content (Markdown)">
        <app-textarea
          [value]="content"
          [rows]="12"
          placeholder="Write operational knowledge here. This will be injected into AI prompts when analyzing tickets for this client."
          (valueChange)="content = $event" />
      </app-form-field>

      <div style="width: 50%">
        <app-form-field label="Sort Order">
          <app-text-input
            [value]="sortOrder.toString()"
            type="number"
            (valueChange)="sortOrder = parseSortOrder($event)" />
        </app-form-field>
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!title.trim() || !content.trim() || saving" (click)="save()">
        {{ saving ? 'Saving...' : (memory() ? 'Update' : 'Create') }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
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

  memoryTypeOptions = MEMORY_TYPE_OPTIONS.map(mt => ({ value: mt.value, label: `${mt.label} — ${mt.description}` }));
  categoryOptions = [...CATEGORY_OPTIONS];

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

  parseSortOrder(value: string): number {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? 0 : n;
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
