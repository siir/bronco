import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';

export interface McpToolVisibilityDialogData {
  tools: Array<{ name: string; description: string }>;
  disabledTools: Set<string>;
}

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatSelectModule, MatButtonModule, MatChipsModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Tool Visibility</h2>
    <mat-dialog-content>
      <p class="summary">
        {{ data.tools.length - disabledTools.size }} of {{ data.tools.length }} tools enabled for agentic analysis.
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
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="apply()">Apply</button>
    </mat-dialog-actions>
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
  `],
})
export class McpToolVisibilityDialogComponent {
  private dialogRef = inject(MatDialogRef<McpToolVisibilityDialogComponent>);
  readonly data: McpToolVisibilityDialogData = inject(MAT_DIALOG_DATA);

  disabledTools = new Set<string>(this.data.disabledTools);
  toolToDisable = '';

  disabledToolList(): string[] {
    return [...this.disabledTools].sort();
  }

  enabledTools(): Array<{ name: string; description: string }> {
    return this.data.tools.filter(t => !this.disabledTools.has(t.name));
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
    this.dialogRef.close(this.disabledTools);
  }
}
