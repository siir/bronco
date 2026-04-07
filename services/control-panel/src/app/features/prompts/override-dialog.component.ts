import { Component, inject, ViewChild, ElementRef, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { PromptService, PromptOverride, PromptKeyword } from '../../core/services/prompt.service';
import { ClientService, Client } from '../../core/services/client.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-override-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Scope</mat-label>
      <mat-select [(ngModel)]="scope" [disabled]="isEdit" (ngModelChange)="onScopeChange()">
        <mat-option value="APP_WIDE">APP_WIDE</mat-option>
        <mat-option value="CLIENT">CLIENT</mat-option>
      </mat-select>
    </mat-form-field>

    @if (scope === 'CLIENT') {
      <mat-form-field class="full-width">
        <mat-label>Client</mat-label>
        <mat-select [(ngModel)]="clientId" [disabled]="isEdit" required>
          @for (c of clients; track c.id) {
            <mat-option [value]="c.id">{{ c.name }} ({{ c.shortCode }})</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }

    <mat-form-field class="full-width">
      <mat-label>Position</mat-label>
      <mat-select [(ngModel)]="position">
        <mat-option value="PREPEND">PREPEND</mat-option>
        <mat-option value="APPEND">APPEND</mat-option>
      </mat-select>
    </mat-form-field>

    <div class="textarea-wrapper">
      <mat-form-field class="full-width">
        <mat-label>Content</mat-label>
        <textarea matInput [(ngModel)]="content" rows="8" required
          #contentTextarea
          (input)="onContentInput($event)"
          (keydown)="onContentKeydown($event)"></textarea>
      </mat-form-field>
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

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!canSave()">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .textarea-wrapper { position: relative; }
    .keyword-popup {
      position: absolute;
      left: 0;
      right: 0;
      z-index: 1000;
      max-height: 210px;
      overflow-y: auto;
      background: var(--mat-sys-surface-container, #fff);
      border: 1px solid var(--mat-sys-outline-variant, #ccc);
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
    .keyword-row:hover {
      background: var(--mat-sys-surface-container-high, #f0f0f0);
    }
    .keyword-token {
      font-family: monospace;
      font-weight: 500;
      color: var(--mat-sys-primary, #1976d2);
    }
    .keyword-label {
      flex: 1;
      color: var(--mat-sys-on-surface-variant, #666);
    }
    .keyword-category {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container, #e0e0e0);
      color: var(--mat-sys-on-secondary-container, #444);
    }
    .keyword-empty {
      color: var(--mat-sys-on-surface-variant, #999);
      font-style: italic;
      cursor: default;
    }
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
