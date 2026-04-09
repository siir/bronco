import { Component, inject, OnInit, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RepoService, type CodeRepo } from '../../core/services/repo.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, TextareaComponent, BroncoButtonComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-repo-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, BroncoButtonComponent],
  template: `
    <div class="form-grid">
      <app-form-field label="Name">
        <app-text-input
          [value]="form.name"
          (valueChange)="form.name = $event" />
      </app-form-field>
      <app-form-field label="Repository URL">
        <app-text-input
          [value]="form.repoUrl"
          placeholder="https://github.com/org/repo.git"
          (valueChange)="form.repoUrl = $event" />
      </app-form-field>
      <app-form-field label="Description (helps AI understand repo contents)">
        <app-textarea
          [value]="form.description"
          [rows]="2"
          placeholder="SQL Server stored procedures, table schemas, and ETL jobs for..."
          (valueChange)="form.description = $event" />
      </app-form-field>
      <div class="row">
        <app-form-field label="Default Branch">
          <app-text-input
            [value]="form.defaultBranch"
            (valueChange)="form.defaultBranch = $event" />
        </app-form-field>
        <app-form-field label="Branch Prefix">
          <app-text-input
            [value]="form.branchPrefix"
            (valueChange)="form.branchPrefix = $event" />
        </app-form-field>
      </div>
    </div>

    <div class="dialog-actions" dialogFooter>
      <app-bronco-button variant="ghost" (click)="cancelled.emit()">Cancel</app-bronco-button>
      <app-bronco-button variant="primary" [disabled]="!form.name || !form.repoUrl" (click)="save()">{{ saveLabel }}</app-bronco-button>
    </div>
  `,
  styles: [`
    .form-grid { display: flex; flex-direction: column; gap: 12px; }
    .row { display: flex; gap: 12px; }
    .row app-form-field { flex: 1; }
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
