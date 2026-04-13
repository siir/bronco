import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CodeRepo, RepoService } from '../../../../core/services/repo.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
  IconComponent,
} from '../../../../shared/components/index.js';
import { RepoDialogComponent } from '../../../repos/repo-dialog.component';

@Component({
  selector: 'app-client-repos-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    IconComponent,
    RepoDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Code Repositories</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openAddDialog()">+ Add Repo</app-bronco-button>
      </div>

      <app-data-table
        [data]="repos()"
        [trackBy]="trackById"
        [rowClickable]="false"
        emptyMessage="No repositories configured.">
        <app-data-column key="name" header="Name" [sortable]="false">
          <ng-template #cell let-r>{{ r.name }}</ng-template>
        </app-data-column>
        <app-data-column key="repoUrl" header="URL" [sortable]="false">
          <ng-template #cell let-r>
            <code class="repo-url">{{ r.repoUrl }}</code>
          </ng-template>
        </app-data-column>
        <app-data-column key="branch" header="Branch" [sortable]="false" width="140px">
          <ng-template #cell let-r>{{ r.defaultBranch }}</ng-template>
        </app-data-column>
        <app-data-column key="prefix" header="Prefix" [sortable]="false" width="120px">
          <ng-template #cell let-r>
            <span class="prefix-chip">{{ r.branchPrefix }}/</span>
          </ng-template>
        </app-data-column>
        <app-data-column key="actions" header="" [sortable]="false" width="100px">
          <ng-template #cell let-r>
            <div class="row-actions">
              <app-bronco-button variant="icon" size="sm" ariaLabel="Edit repository" (click)="openEditDialog(r)"><app-icon name="edit" size="sm" /></app-bronco-button>
              <app-bronco-button variant="icon" size="sm" ariaLabel="Delete repository" (click)="deleteRepo(r)"><app-icon name="delete" size="sm" /></app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        [title]="editing() ? 'Edit Code Repository' : 'Add Code Repository'"
        maxWidth="500px"
        (openChange)="showDialog.set(false)">
        <app-repo-dialog-content
          [clientId]="clientId()"
          [repo]="editing() ?? undefined"
          (saved)="onSaved()"
          (cancelled)="showDialog.set(false)" />
      </app-dialog>
    }
  `,
  styles: [`
    :host { display: block; }

    .tab-section { padding: 16px 0; }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .section-title {
      margin: 0;
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .repo-url {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-code);
      padding: 1px 6px;
      border-radius: var(--radius-sm);
    }

    .prefix-chip {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-active);
      color: var(--accent);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    }

    .row-actions {
      display: inline-flex;
      gap: 4px;
    }
  `],
})
export class ClientReposTabComponent implements OnInit {
  clientId = input.required<string>();

  private repoService = inject(RepoService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  repos = signal<CodeRepo[]>([]);
  showDialog = signal(false);
  editing = signal<CodeRepo | null>(null);

  trackById = (r: CodeRepo): string => r.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.repoService.getRepos(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(r => this.repos.set(r));
  }

  openAddDialog(): void {
    this.editing.set(null);
    this.showDialog.set(true);
  }

  openEditDialog(repo: CodeRepo): void {
    this.editing.set(repo);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }

  deleteRepo(repo: CodeRepo): void {
    if (!confirm(`Delete repo "${repo.name}"?`)) return;
    this.repoService.deleteRepo(repo.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Repository deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
      });
  }
}
