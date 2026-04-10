import { Component, input, output, OnInit } from '@angular/core';
import { FormFieldComponent, SelectComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-mcp-tool-visibility-dialog-content',
  standalone: true,
  imports: [FormFieldComponent, SelectComponent, BroncoButtonComponent],
  template: `
    <p class="summary">
      {{ tools().length - disabledTools.size }} of {{ tools().length }} tools enabled for agentic analysis.
    </p>

    @if (disabledTools.size > 0) {
      <div class="disabled-section">
        <p class="section-label">Hidden from AI:</p>
        <div class="chip-list">
          @for (name of disabledToolList(); track name) {
            <span class="chip">
              {{ name }}
              <button type="button" class="chip-remove" [attr.aria-label]="'Enable ' + name" (click)="enable(name)">&times;</button>
            </span>
          }
        </div>
      </div>
    } @else {
      <p class="all-enabled">All tools are currently enabled.</p>
    }

    @if (enabledToolOptions().length > 0) {
      <app-form-field label="Disable a tool…">
        <app-select
          [value]="toolToDisable"
          [options]="enabledToolOptions()"
          (valueChange)="toolToDisable = $event; disableSelected()" />
      </app-form-field>
    }

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" (click)="apply()">Apply</app-bronco-button>
    </div>
  `,
  styles: [`
    .summary { font-size: 13px; color: var(--text-secondary); margin: 0 0 12px; }
    .section-label { font-size: 12px; color: var(--text-secondary); margin: 0 0 6px; }
    .disabled-section { margin-bottom: 16px; }
    .all-enabled { font-size: 13px; color: var(--color-success); margin: 0 0 16px; }
    .chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: var(--bg-muted); border-radius: var(--radius-pill); font-size: 13px; color: var(--text-primary); }
    .chip-remove { background: none; border: none; cursor: pointer; color: var(--text-secondary); font-size: 16px; line-height: 1; padding: 0; display: flex; align-items: center; }
    .chip-remove:hover { color: var(--color-error); }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  `],
})
export class McpToolVisibilityDialogComponent implements OnInit {
  tools = input<Array<{ name: string; description: string }>>([]);
  initialDisabledTools = input<Set<string>>(new Set());

  applied = output<Set<string>>();
  cancelled = output<void>();

  disabledTools = new Set<string>();
  toolToDisable = '';

  ngOnInit(): void {
    this.disabledTools = new Set(this.initialDisabledTools());
  }

  disabledToolList(): string[] {
    return [...this.disabledTools].sort();
  }

  enabledToolOptions(): Array<{ value: string; label: string }> {
    const enabled = this.tools()
      .filter(t => !this.disabledTools.has(t.name))
      .map(t => ({ value: t.name, label: t.description ? `${t.name} — ${t.description}` : t.name }));
    if (enabled.length === 0) return [];
    return [{ value: '', label: '— Select a tool —' }, ...enabled];
  }

  enable(name: string): void {
    this.disabledTools = new Set(this.disabledTools);
    this.disabledTools.delete(name);
  }

  disableSelected(): void {
    if (!this.toolToDisable) return;
    this.disabledTools = new Set(this.disabledTools);
    this.disabledTools.add(this.toolToDisable);
    this.toolToDisable = '';
  }

  apply(): void {
    this.applied.emit(this.disabledTools);
  }
}
