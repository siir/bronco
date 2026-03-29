import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RepoService, type CodeRepo } from '../../core/services/repo.service';

@Component({
  standalone: true,
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ title }}</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Name</mat-label>
        <input matInput [(ngModel)]="form.name" required>
      </mat-form-field>
      <mat-form-field class="full-width">
        <mat-label>Repository URL</mat-label>
        <input matInput [(ngModel)]="form.repoUrl" required placeholder="https://github.com/org/repo.git">
      </mat-form-field>
      <div class="row">
        <mat-form-field class="flex">
          <mat-label>Default Branch</mat-label>
          <input matInput [(ngModel)]="form.defaultBranch">
        </mat-form-field>
        <mat-form-field class="flex">
          <mat-label>Branch Prefix</mat-label>
          <input matInput [(ngModel)]="form.branchPrefix">
        </mat-form-field>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!form.name || !form.repoUrl">{{ saveLabel }}</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .row { display: flex; gap: 12px; }
    .flex { flex: 1; }
  `],
})
export class RepoDialogComponent {
  private dialogRef = inject(MatDialogRef<RepoDialogComponent>);
  private data: { clientId: string; repo?: CodeRepo } = inject(MAT_DIALOG_DATA);
  private repoService = inject(RepoService);
  private snackBar = inject(MatSnackBar);

  title = this.data.repo ? 'Edit Code Repository' : 'Add Code Repository';
  saveLabel = this.data.repo ? 'Save' : 'Create';

  form = {
    name: this.data.repo?.name ?? '',
    repoUrl: this.data.repo?.repoUrl ?? '',
    defaultBranch: this.data.repo?.defaultBranch ?? 'master',
    branchPrefix: this.data.repo?.branchPrefix ?? 'claude',
  };

  save(): void {
    const payload = {
      name: this.form.name,
      repoUrl: this.form.repoUrl,
      defaultBranch: this.form.defaultBranch,
      branchPrefix: this.form.branchPrefix,
    };

    const request$ = this.data.repo
      ? this.repoService.updateRepo(this.data.repo.id, payload)
      : this.repoService.createRepo({ ...payload, clientId: this.data.clientId });

    request$.subscribe({
      next: () => {
        this.snackBar.open(this.data.repo ? 'Repo updated' : 'Repo created', 'OK', { duration: 3000, panelClass: 'success-snackbar' });
        this.dialogRef.close(true);
      },
      error: (err) => this.snackBar.open(err.error?.error ?? 'Failed', 'OK', { duration: 5000, panelClass: 'error-snackbar' }),
    });
  }
}
