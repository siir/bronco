import { Component, inject, ViewChild, ElementRef, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PromptService, PromptOverride, PromptKeyword } from '../../core/services/prompt.service';
import { ClientService, Client } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';
import { FormFieldComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-override-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Scope">
        <app-select
          [value]="scope"
          [options]="scopeOptions"
          [disabled]="isEdit"
          (valueChange)="scope = $event; onScopeChange()" />
      </app-form-field>

      @if (scope === 'CLIENT') {
        <app-form-field label="Client">
          <app-select
            [value]="clientId"
            [options]="clientOptions"
            [disabled]="isEdit"
            (valueChange)="clientId = $event" />
        </app-form-field>
      }

      <app-form-field label="Position">
        <app-select
          [value]="position"
          [options]="positionOptions"
          (valueChange)="position = $event" />
      </app-form-field>

      <div class="textarea-wrapper">
        <app-form-field label="Content">
          <textarea
            #contentTextarea
            class="content-textarea"
            [(ngModel)]="content"
            rows="8"
            placeholder="Enter prompt override content..."
            (input)="onContentInput($event)"
            (keydown)="onContentKeydown($event)"></textarea>
        </app-form-field>
        @if (showKeywordPopup) {
          <div class="keyword-popup">
            @for (kw of filteredKeywords; track kw.id) {
              <div class="keyword-row" (mousedown)="insertKeyword(kw, $event)">
                <span class="keyword-token">{{ kw.token }}</span>
                <span class="keyword-label">{{ kw.label }}</span>
                <span class="keyword-category">{{ kw.category }}</span>
              </div>
            }
            @if (filteredKeywords.length === 0) {
              <div class="keyword-row keyword-empty">No matching keywords</div>
            }
          </div>
        }
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!canSave()" (click)="save()">
        {{ isEdit ? 'Update' : 'Create' }}
      </app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .textarea-wrapper { position: relative; }
    .content-textarea {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-md);
      padding: 8px 12px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
      resize: vertical;
      outline: none;
    }
    .content-textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring);
    }
    .keyword-popup {
      position: absolute;
      left: 0;
      right: 0;
      z-index: 1000;
      max-height: 210px;
      overflow-y: auto;
      background: var(--bg-card, #fff);
      border: 1px solid var(--border-medium, #ccc);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    .keyword-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 13px;
    }
    .keyword-row:hover { background: var(--bg-hover, #f0f0f0); }
    .keyword-token { font-family: monospace; font-weight: 500; color: var(--accent, #1976d2); }
    .keyword-label { flex: 1; color: var(--text-secondary, #666); }
    .keyword-category {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--bg-hover, #e0e0e0);
      color: var(--text-secondary, #444);
    }
    .keyword-empty { color: var(--text-tertiary, #999); font-style: italic; cursor: default; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class OverrideDialogComponent implements OnInit {
  private promptService = inject(PromptService);
  private clientService = inject(ClientService);
  private toast = inject(ToastService);

  promptKey = input.required<string>();
  override = input<PromptOverride>();

  saved = output<PromptOverride>();
  cancelled = output<void>();

  @ViewChild('contentTextarea') contentTextareaRef!: ElementRef<HTMLTextAreaElement>;

  scopeOptions = [
    { value: 'APP_WIDE', label: 'APP_WIDE' },
    { value: 'CLIENT', label: 'CLIENT' },
  ];

  positionOptions = [
    { value: 'PREPEND', label: 'PREPEND' },
    { value: 'APPEND', label: 'APPEND' },
  ];

  isEdit = false;
  scope = 'APP_WIDE';
  clientId = '';
  position = 'APPEND';
  content = '';
  clients: Client[] = [];

  keywords: PromptKeyword[] = [];
  filteredKeywords: PromptKeyword[] = [];
  showKeywordPopup = false;
  keywordSearchStart = -1;

  get clientOptions(): Array<{ value: string; label: string }> {
    return [
      { value: '', label: 'Select client...' },
      ...this.clients.map(c => ({ value: c.id, label: `${c.name} (${c.shortCode})` })),
    ];
  }

  ngOnInit(): void {
    const o = this.override();
    if (o) {
      this.isEdit = true;
      this.scope = o.scope ?? 'APP_WIDE';
      this.clientId = o.clientId ?? '';
      this.position = o.position ?? 'APPEND';
      this.content = o.content ?? '';
    }

    if (this.scope === 'CLIENT' || !this.isEdit) {
      this.clientService.getClients().subscribe(c => this.clients = c);
    }
    this.promptService.getKeywords().subscribe(kw => this.keywords = kw);
  }

  onScopeChange(): void {
    if (this.scope === 'APP_WIDE') {
      this.clientId = '';
    } else if (this.clients.length === 0) {
      this.clientService.getClients().subscribe(c => this.clients = c);
    }
  }

  onContentInput(_event: Event): void {
    const textarea = this.contentTextareaRef?.nativeElement;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const textBefore = this.content.slice(0, cursorPos);

    const lastOpen = textBefore.lastIndexOf('{{');
    if (lastOpen === -1) {
      this.showKeywordPopup = false;
      return;
    }

    const afterOpen = textBefore.slice(lastOpen + 2);
    if (afterOpen.includes('}}')) {
      this.showKeywordPopup = false;
      return;
    }

    if (afterOpen.includes('\n')) {
      this.showKeywordPopup = false;
      return;
    }

    const search = afterOpen.toLowerCase();
    this.keywordSearchStart = lastOpen;
    this.filteredKeywords = this.keywords.filter(
      kw => kw.token.toLowerCase().includes(search) || kw.label.toLowerCase().includes(search),
    ).slice(0, 6);
    this.showKeywordPopup = true;
  }

  onContentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.showKeywordPopup) {
      this.showKeywordPopup = false;
      event.stopPropagation();
    }
  }

  insertKeyword(keyword: PromptKeyword, event: MouseEvent): void {
    event.preventDefault();
    const textarea = this.contentTextareaRef?.nativeElement;
    if (!textarea) return;

    const replacement = `{{${keyword.token}}}`;
    const cursorPos = textarea.selectionStart;
    const before = this.content.slice(0, this.keywordSearchStart);
    const after = this.content.slice(cursorPos);
    this.content = before + replacement + after;
    this.showKeywordPopup = false;

    const newCursor = before.length + replacement.length;
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(newCursor, newCursor);
    });
  }

  canSave(): boolean {
    if (!this.content.trim()) return false;
    if (this.scope === 'CLIENT' && !this.clientId) return false;
    return true;
  }

  save(): void {
    if (this.isEdit) {
      this.promptService.updateOverride(this.override()!.id, {
        position: this.position,
        content: this.content,
      }).subscribe({
        next: (result) => {
          this.toast.success('Override updated');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to update override'),
      });
    } else {
      this.promptService.createOverride({
        promptKey: this.promptKey(),
        scope: this.scope,
        clientId: this.scope === 'CLIENT' ? this.clientId : undefined,
        position: this.position,
        content: this.content,
      }).subscribe({
        next: (result) => {
          this.toast.success('Override created');
          this.saved.emit(result);
        },
        error: (err) => this.toast.error(err.error?.message ?? 'Failed to create override'),
      });
    }
  }
}
