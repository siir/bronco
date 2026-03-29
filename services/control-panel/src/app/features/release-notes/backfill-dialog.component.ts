import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

@Component({
  standalone: true,
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  template: `
    <h2 mat-dialog-title>Sync History</h2>
    <mat-dialog-content>
      <p>Fetch commits from GitHub and generate release notes for a range of commits.</p>
      <mat-form-field class="full-width">
        <mat-label>From SHA (base)</mat-label>
        <input matInput [(ngModel)]="fromSha" placeholder="e.g. abc1234">
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>To SHA / branch</mat-label>
        <input matInput [(ngModel)]="toSha" placeholder="e.g. def5678 or master">
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="cancel()">Cancel</button>
      <button mat-raised-button color="primary" [disabled]="!fromSha.trim() || !toSha.trim()" (click)="confirm()">
        Sync
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; }
    mat-dialog-content { display: flex; flex-direction: column; gap: 8px; min-width: 360px; }
    p { color: #666; font-size: 14px; margin-top: 0; }
  `],
})
export class BackfillDialogComponent {
  private dialogRef = inject(MatDialogRef<BackfillDialogComponent>);

  fromSha = '';
  toSha = 'master';

  cancel(): void {
    this.dialogRef.close();
  }

  confirm(): void {
    const result = {
      fromSha: this.fromSha.trim(),
      toSha: this.toSha.trim(),
    };
    this.dialogRef.close(result);
  }
}
