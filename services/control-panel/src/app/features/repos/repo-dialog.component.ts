import { Component, DestroyRef, inject, OnInit, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RepoService, type CodeRepo } from '../../core/services/repo.service.js';
import { IntegrationService, type ClientIntegration } from '../../core/services/integration.service.js';
import { ToastService } from '../../core/services/toast.service.js';
import { FormFieldComponent, TextInputComponent, TextareaComponent, BroncoButtonComponent, SelectComponent } from '../../shared/components/index.js';

@Component({
  selector: 'app-repo-dialog-content',
  standalone: true,
  imports: [FormsModule, FormFieldComponent, TextInputComponent, TextareaComponent, BroncoButtonComponent, SelectComponent],
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
      <app-form-field label="GitHub Integration" hint="Credentials used to clone. Leave on Platform default unless this repo needs its own token.">
        <app-select
          [value]="form.githubIntegrationId ?? ''"
          [options]="githubIntegrationOptions()"
          (valueChange)="form.githubIntegrationId = $event === '' ? null : $event" />
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

    @media (max-width: 767.98px) {
      .row { flex-direction: column; gap: 12px; }
    }
  `],
})
export class RepoDialogComponent implements OnInit {
  private repoService = inject(RepoService);
  private integrationService = inject(IntegrationService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

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
    githubIntegrationId: null as string | null,
  };

  // Signal so the Select options refresh after async integration load.
  githubIntegrationOptions = signal<Array<{ value: string; label: string }>>([
    { value: '', label: '(Platform default)' },
  ]);

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
        githubIntegrationId: r.githubIntegrationId ?? null,
      };
    }

    // Load GITHUB integrations visible to this client (client-scoped + platform-scoped).
    // Each request is guarded with catchError so a failure on one source still allows
    // the dropdown to render with whatever loaded successfully from the other source.
    forkJoin({
      client: this.integrationService.getGithubIntegrationsForClient(this.clientId()).pipe(catchError(() => of([] as ClientIntegration[]))),
      platform: this.integrationService.getPlatformGithubIntegrations().pipe(catchError(() => of([] as ClientIntegration[]))),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ client, platform }) => {
        this.githubIntegrationOptions.set(this.buildOptions(client, platform));
      });
  }

  private buildOptions(clientScoped: ClientIntegration[], platformScoped: ClientIntegration[]): Array<{ value: string; label: string }> {
    const options: Array<{ value: string; label: string }> = [{ value: '', label: '(Platform default)' }];
    for (const i of clientScoped) {
      if (!i.isActive) continue;
      options.push({ value: i.id, label: `${i.label} — client` });
    }
    for (const i of platformScoped) {
      if (!i.isActive) continue;
      options.push({ value: i.id, label: `${i.label} — platform` });
    }
    return options;
  }

  save(): void {
    const payload = {
      name: this.form.name,
      repoUrl: this.form.repoUrl,
      description: this.form.description || undefined,
      defaultBranch: this.form.defaultBranch,
      branchPrefix: this.form.branchPrefix,
      githubIntegrationId: this.form.githubIntegrationId,
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
