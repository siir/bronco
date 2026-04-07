import { Component, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

@Component({
  selector: 'app-backfill-dialog-content',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <p>Fetch commits from GitHub and generate release notes for a range of commits.</p>
    <mat-form-field class="full-width">
      <mat-label>From SHA (base)</mat-label>
      <input matInput [(ngModel)]="fromSha" placeholder="e.g. abc1234">
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>To SHA / branch</mat-label>
      <input matInput [(ngModel)]="toSha" placeholder="e.g. def5678 or master">
    </mat-form-field>

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" [disabled]="!fromSha.trim() || !toSha.trim()" (click)="confirm()">
        Sync
      </button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; }
    p { color: #666; font-size: 14px; margin-top: 0; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class BackfillDialogComponent {
  submitted = output<{ fromSha: string; toSha?: string }>();
  cancelled = output<void>();

  fromSha = '';
  toSha = 'master';

  confirm(): void {
    this.submitted.emit({
      fromSha: this.fromSha.trim(),
      toSha: this.toSha.trim(),
    });
  }
}
