import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AiUsageService, AiModelCost } from '../../core/services/ai-usage.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ isEdit ? 'Edit' : 'Add' }} Model Cost</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Provider</mat-label>
        <mat-select [(ngModel)]="provider" [disabled]="isEdit" required>
          @for (p of catalogProviders; track p) {
            <mat-option [value]="p">{{ p }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Model ID</mat-label>
        <input matInput [(ngModel)]="model" [readonly]="isEdit" required placeholder="e.g. claude-sonnet-4-6">
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Display Name</mat-label>
        <input matInput [(ngModel)]="displayName" placeholder="e.g. Claude Sonnet 4.6">
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Input Cost ($/1M tokens)</mat-label>
        <input matInput type="number" [(ngModel)]="inputCostPer1m" required min="0" step="0.01">
      </mat-form-field>

      <mat-form-field class="full-width">
        <mat-label>Output Cost ($/1M tokens)</mat-label>
        <input matInput type="number" [(ngModel)]="outputCostPer1m" required min="0" step="0.01">
      </mat-form-field>

      <mat-checkbox [(ngModel)]="isCustomCost">
        Custom cost (protect from AI updates)
      </mat-checkbox>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!provider || !model">
        {{ isEdit ? 'Update' : 'Create' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`.full-width { width: 100%; margin-bottom: 8px; }`],
})
export class ModelCostDialogComponent implements OnInit {
  private dialogRef = inject(MatDialogRef<ModelCostDialogComponent>);
  private data = inject<{ cost?: AiModelCost }>(MAT_DIALOG_DATA);
  private aiUsageService = inject(AiUsageService);
  private snackBar = inject(MatSnackBar);

  isEdit = !!this.data.cost;
  provider = this.data.cost?.provider ?? '';
  model = this.data.cost?.model ?? '';
  displayName = this.data.cost?.displayName ?? '';
  inputCostPer1m = this.data.cost?.inputCostPer1m ?? 0;
  outputCostPer1m = this.data.cost?.outputCostPer1m ?? 0;
  isCustomCost = this.data.cost?.isCustomCost ?? true;

  catalogProviders: string[] = [];

  ngOnInit(): void {
    this.aiUsageService.getCatalog().subscribe(catalog => {
      this.catalogProviders = catalog.providers.map(p => p.provider);
      // If editing, ensure current provider is in the list
      if (this.provider && !this.catalogProviders.includes(this.provider)) {
        this.catalogProviders.push(this.provider);
      }
      // If no catalog (empty costs table), fall back to known providers
      if (this.catalogProviders.length === 0) {
        this.catalogProviders = ['CLAUDE', 'OPENAI', 'LOCAL', 'GROK', 'GOOGLE'];
      }
    });
  }

  save(): void {
    this.aiUsageService.upsertCost({
      provider: this.provider,
      model: this.model,
      displayName: this.displayName || undefined,
      inputCostPer1m: this.inputCostPer1m,
      outputCostPer1m: this.outputCostPer1m,
      isCustomCost: this.isCustomCost,
    }).subscribe({
      next: () => {
        this.snackBar.open(this.isEdit ? 'Cost updated' : 'Model cost added', 'OK', { duration: 3000 });
        this.dialogRef.close(true);
      },
      error: (err) => this.snackBar.open(err.error?.message ?? 'Failed to save', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
}
