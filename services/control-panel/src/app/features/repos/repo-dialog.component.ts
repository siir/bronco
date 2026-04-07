import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { RepoService, type CodeRepo } from '../../core/services/repo.service';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-repo-dialog-content',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <mat-form-field class="full-width">
      <mat-label>Name</mat-label>
      <input matInput [(ngModel)]="form.name" required>
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Repository URL</mat-label>
      <input matInput [(ngModel)]="form.repoUrl" required placeholder="https://github.com/org/repo.git">
    </mat-form-field>
    <mat-form-field class="full-width">
      <mat-label>Description (helps AI understand repo contents)</mat-label>
      <textarea matInput [(ngModel)]="form.description" rows="2"
        placeholder="SQL Server stored procedures, table schemas, and ETL jobs for..."></textarea>
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

    <div class="dialog-actions" dialogFooter>
      <button mat-button (click)="cancelled.emit()">Cancel</button>
      <button mat-raised-button color="primary" (click)="save()" [disabled]="!form.name || !form.repoUrl">{{ saveLabel }}</button>
    </div>
  `,
  styles: [`
    .full-width { width: 100%; margin-bottom: 8px; }
    .row { display: flex; gap: 12px; }
    .flex { flex: 1; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class RepoDialogComponent implements OnInit {
  private repoService = inject(RepoService);
  private toast = inject(ToastService);

  clientId = input.required<string>();
  repo = input<CodeRepo>();

  saved = output<boolean>();
  cancelled = output<void>();

  isEdit = false;
  saveLabel = 'Create';

  form = {
    name: '',
    repoUrl: '',
    description: '',
    defaultBranch: 'master',
    branchPrefix: 'claude',
  };

  ngOnInit(): void {
    const r = this.repo();
    if (r) {
      this.isEdit = true;
      this.saveLabel = 'Save';
      this.form = {
        name: r.name ?? '',
        repoUrl: r.repoUrl ?? '',
        description: r.description ?? '',
        defaultBranch: r.defaultBranch ?? 'master',
        branchPrefix: r.branchPrefix ?? 'claude',
      };
    }
  }

  save(): void {
    const payload = {
      name: this.form.name,
      repoUrl: this.form.repoUrl,
      description: this.form.description || undefined,
      defaultBranch: this.form.defaultBranch,
      branchPrefix: this.form.branchPrefix,
    };

    const r = this.repo();
    const request$ = r
      ? this.repoService.updateRepo(r.id, payload)
      : this.repoService.createRepo({ ...payload, clientId: this.clientId() });

    request$.subscribe({
      next: () => {
        this.toast.success(r ? 'Repo updated' : 'Repo created');
        this.saved.emit(true);
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Failed'),
    });
  }
}
