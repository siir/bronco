import { Component, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BroncoButtonComponent, TextareaComponent, IconComponent } from '../../shared/components/index.js';
import { MarkdownPipe } from '../../shared/pipes/markdown.pipe';

@Component({
  selector: 'app-ticket-detail-knowledge',
  standalone: true,
  imports: [FormsModule, BroncoButtonComponent, TextareaComponent, MarkdownPipe, IconComponent],
  template: `
    <div class="knowledge-doc">
      @if (editing()) {
        <app-textarea
          [value]="draft()"
          [rows]="20"
          (valueChange)="draft.set($event)" />
        <div class="knowledge-actions">
          <app-bronco-button variant="primary" (click)="onSave()">Save</app-bronco-button>
          <app-bronco-button variant="secondary" (click)="onCancel()">Cancel</app-bronco-button>
        </div>
      } @else {
        <div class="knowledge-actions">
          <app-bronco-button variant="secondary" (click)="onStartEdit()">
            <app-icon name="edit" size="sm" /> Edit
          </app-bronco-button>
          <app-bronco-button variant="destructive" (click)="onClear()">
            <app-icon name="delete" size="sm" /> Clear
          </app-bronco-button>
        </div>
        @if (knowledgeDoc()) {
          <div class="knowledge-body" [innerHTML]="knowledgeDoc() | markdown"></div>
        }
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      font-family: var(--font-primary);
      color: var(--text-primary);
    }
    .knowledge-doc {
      font-size: 14px;
      line-height: 1.6;
    }
    .knowledge-doc h3 {
      margin-top: 16px;
      margin-bottom: 8px;
      font-size: 16px;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border-light);
      padding-bottom: 4px;
    }
    .knowledge-doc h4 {
      margin-top: 12px;
      margin-bottom: 6px;
      font-size: 14px;
      color: var(--text-secondary);
    }
    .knowledge-doc pre {
      background: var(--bg-code);
      color: var(--text-code);
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      overflow-x: auto;
      font-size: 12px;
    }
    .knowledge-doc code {
      background: var(--bg-muted);
      padding: 1px 4px;
      border-radius: var(--radius-sm);
      font-size: 12px;
    }
    .knowledge-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
  `],
})
export class TicketDetailKnowledgeComponent {
  knowledgeDoc = input<string | null>(null);
  editing = input<boolean>(false);

  startEdit = output<void>();
  cancelEdit = output<void>();
  save = output<string>();
  clear = output<void>();

  draft = signal('');

  onStartEdit(): void {
    this.draft.set(this.knowledgeDoc() ?? '');
    this.startEdit.emit();
  }

  onCancel(): void {
    this.draft.set('');
    this.cancelEdit.emit();
  }

  onSave(): void {
    this.save.emit(this.draft());
  }

  onClear(): void {
    this.clear.emit();
  }
}
