import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ClientMemory, ClientMemoryService } from '../../../../core/services/client-memory.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  CardComponent,
  DialogComponent,
  SelectComponent,
  ToggleSwitchComponent,
  IconComponent,
} from '../../../../shared/components/index.js';
import { ClientMemoryDialogComponent } from '../../client-memory-dialog.component';

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'MANUAL', label: 'Manual' },
  { value: 'AI_LEARNED', label: 'AI Learned' },
];

@Component({
  selector: 'app-client-memory-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    CardComponent,
    DialogComponent,
    IconComponent,
    SelectComponent,
    ToggleSwitchComponent,
    ClientMemoryDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">AI Memory</h3>
        <div class="header-actions">
          <app-select
            class="source-filter"
            [value]="sourceFilter()"
            [options]="sourceOptions"
            placeholder="All sources"
            (valueChange)="sourceFilter.set($event)" />
          <app-bronco-button variant="primary" size="sm" (click)="openAddDialog()">+ Add Memory</app-bronco-button>
        </div>
      </div>

      @for (mem of filteredMemories(); track mem.id) {
        <app-card padding="md" class="memory-card" [class.inactive-card]="!mem.isActive">
          <div class="memory-header">
            <span class="type-icon">{{ memoryTypeIcon(mem.memoryType) }}</span>
            <strong class="memory-title">{{ mem.title }}</strong>
            <span class="chip chip-type chip-type-{{ mem.memoryType.toLowerCase() }}">{{ mem.memoryType }}</span>
            <span class="chip chip-source chip-source-{{ mem.source.toLowerCase() }}">
              {{ mem.source === 'AI_LEARNED' ? 'AI' : 'MANUAL' }}
            </span>
            @if (mem.category) {
              <span class="chip chip-category">{{ mem.category }}</span>
            }
            <app-toggle-switch
              [checked]="mem.isActive"
              [label]="mem.isActive ? 'Active' : 'Inactive'"
              (checkedChange)="toggleMemory(mem, $event)" />
            <span class="spacer"></span>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Edit memory" (click)="openEditDialog(mem)"><app-icon name="edit" size="sm" /></app-bronco-button>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Delete memory" (click)="deleteMemory(mem.id)"><app-icon name="delete" size="sm" /></app-bronco-button>
          </div>
          @if (mem.tags.length) {
            <div class="tags">
              @for (tag of mem.tags; track tag) {
                <span class="chip chip-tag">{{ tag }}</span>
              }
            </div>
          }
          <pre class="memory-content">{{ mem.content }}</pre>
        </app-card>
      } @empty {
        <p class="empty">No memory entries. Add context, playbooks, or tool guidance to help AI analyze tickets for this client.</p>
      }
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        [title]="editing() ? 'Edit Client Memory' : 'Add Client Memory'"
        maxWidth="650px"
        (openChange)="showDialog.set(false)">
        <app-client-memory-dialog-content
          [clientId]="clientId()"
          [memory]="editing() ?? undefined"
          (saved)="onSaved()"
          (cancelled)="showDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    :host { display: block; }

    .tab-section { padding: 16px 0; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 12px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .source-filter {
      display: inline-block;
      min-width: 160px;
    }

    .memory-card {
      margin-bottom: 12px;
    }

    .memory-card.inactive-card {
      opacity: 0.6;
    }

    .memory-header {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .type-icon {
      font-size: 16px;
      line-height: 1;
    }

    .memory-title {
      font-family: var(--font-primary);
      font-size: 14px;
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

    .chip-type-context {
      background: var(--color-info-subtle);
      color: var(--color-info);
    }
    .chip-type-playbook {
      background: var(--color-error-subtle);
      color: var(--color-error);
    }
    .chip-type-tool_guidance {
      background: var(--color-purple-subtle);
      color: var(--color-purple);
    }

    .chip-source {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.3px;
      padding: 1px 5px;
      text-transform: uppercase;
    }
    .chip-source-manual {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }
    .chip-source-ai_learned {
      background: var(--color-purple-subtle);
      color: var(--color-purple);
    }

    .chip-category {
      background: var(--color-warning-subtle);
      color: var(--color-warning);
    }

    .chip-tag {
      background: var(--bg-muted);
      color: var(--text-secondary);
    }

    .spacer { flex: 1; }

    .tags {
      display: flex;
      gap: 4px;
      margin: 10px 0 4px;
      flex-wrap: wrap;
    }

    .memory-content {
      background: var(--bg-code);
      color: var(--text-code);
      padding: 10px 14px;
      border-radius: var(--radius-md);
      font-size: 12px;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      white-space: pre-wrap;
      word-wrap: break-word;
      max-height: 240px;
      overflow-y: auto;
      margin: 10px 0 0;
    }

    .empty {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 14px;
      padding: 32px 16px;
      text-align: center;
    }
  `],
})
export class ClientMemoryTabComponent implements OnInit {
  clientId = input.required<string>();

  private memoryService = inject(ClientMemoryService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  memories = signal<ClientMemory[]>([]);
  sourceFilter = signal<string>('');
  showDialog = signal(false);
  editing = signal<ClientMemory | null>(null);

  readonly sourceOptions = SOURCE_OPTIONS;

  filteredMemories = computed(() => {
    const filter = this.sourceFilter();
    const all = this.memories();
    if (!filter) return all;
    return all.filter(m => (m.source ?? 'MANUAL') === filter);
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.memoryService.getMemories({ clientId: this.clientId() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(m => this.memories.set(m));
  }

  openAddDialog(): void {
    this.editing.set(null);
    this.showDialog.set(true);
  }

  openEditDialog(mem: ClientMemory): void {
    this.editing.set(mem);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }

  toggleMemory(mem: ClientMemory, checked: boolean): void {
    this.memories.update(list => list.map(m => m.id === mem.id ? { ...m, isActive: checked } : m));
    this.memoryService.updateMemory(mem.id, { isActive: checked })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.toast.success(`Memory ${checked ? 'enabled' : 'disabled'}`),
        error: (err) => {
          this.memories.update(list => list.map(m => m.id === mem.id ? { ...m, isActive: !checked } : m));
          this.toast.error(err.error?.message ?? err.error?.error ?? 'Toggle failed');
        },
      });
  }

  deleteMemory(id: string): void {
    this.memoryService.deleteMemory(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Memory entry deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
      });
  }

  memoryTypeIcon(type: string): string {
    switch (type) {
      case 'CONTEXT': return '\u2139';        // ℹ
      case 'PLAYBOOK': return '\u{1F4D6}';   // 📖
      case 'TOOL_GUIDANCE': return '\u{1F527}'; // 🔧
      default: return '\u{1F9E0}';            // 🧠
    }
  }
}
