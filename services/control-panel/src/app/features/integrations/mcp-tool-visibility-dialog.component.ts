import { Component, input, output, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-mcp-tool-visibility-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatSelectModule, MatButtonModule, MatChipsModule, MatIconModule],
  template: `
    <p class="summary">
      {{ tools().length - disabledTools.size }} of {{ tools().length }} tools enabled for agentic analysis.
    </p>

    @if (disabledTools.size > 0) {
      <div class="disabled-section">
        <p class="section-label">Hidden from AI:</p>
        <mat-chip-set>
          @for (name of disabledToolList(); track name) {
            <mat-chip (removed)="enable(name)">
              {{ name }}
              <button matChipRemove><mat-icon>cancel</mat-icon></button>
            </mat-chip>
          }
        </mat-chip-set>
      </div>
    } @else {
      <p class="all-enabled">All tools are currently enabled.</p>
    }

    @if (enabledTools().length > 0) {
      <mat-form-field class="add-field">
        <mat-label>Disable a tool…</mat-label>
        <mat-select [(ngModel)]="toolToDisable" (ngModelChange)="disableSelected()">
          @for (tool of enabledTools(); track tool.name) {
            <mat-option [value]="tool.name">
              <span class="opt-name">{{ tool.name }}</span>
              @if (tool.description) {
                <span class="opt-desc"> — {{ tool.description }}</span>
              }
            </mat-option>
          }
        </mat-select>
      </mat-form-field>
    }

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="apply()">Apply</button>
    </div>
  `,
  styles: [`
    .summary { font-size: 13px; color: #555; margin: 0 0 12px; }
    .section-label { font-size: 12px; color: #777; margin: 0 0 6px; }
    .disabled-section { margin-bottom: 16px; }
    .all-enabled { font-size: 13px; color: #4caf50; margin: 0 0 16px; }
    .add-field { width: 100%; }
    .opt-name { font-weight: 500; }
    .opt-desc { font-size: 12px; color: #888; }
    mat-chip { font-size: 13px; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
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

  enabledTools(): Array<{ name: string; description: string }> {
    return this.tools().filter(t => !this.disabledTools.has(t.name));
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
