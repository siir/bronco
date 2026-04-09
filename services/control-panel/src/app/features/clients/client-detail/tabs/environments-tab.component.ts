import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ClientEnvironment, ClientEnvironmentService } from '../../../../core/services/client-environment.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  BroncoButtonComponent,
  CardComponent,
  DialogComponent,
  ToggleSwitchComponent,
  IconComponent,
} from '../../../../shared/components/index.js';
import { ClientEnvironmentDialogComponent } from '../../client-environment-dialog.component';

@Component({
  selector: 'app-client-environments-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    CardComponent,
    DialogComponent,
    ToggleSwitchComponent,
    ClientEnvironmentDialogComponent,
    IconComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Environments</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openAddDialog()">+ Add Environment</app-bronco-button>
      </div>

      @for (env of environments(); track env.id) {
        <app-card padding="md" class="env-card" [class.inactive-card]="!env.isActive">
          <div class="env-header">
            <app-icon name="cloud" size="sm" class="env-icon" aria-hidden="true" />
            <strong class="env-name">{{ env.name }}</strong>
            <span class="chip chip-tag">{{ env.tag }}</span>
            @if (env.isDefault) {
              <span class="chip chip-default">Default</span>
            }
            <app-toggle-switch
              [checked]="env.isActive"
              [label]="env.isActive ? 'Active' : 'Inactive'"
              (checkedChange)="toggleEnvironment(env, $event)" />
            <span class="spacer"></span>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Edit environment" (click)="openEditDialog(env)"><app-icon name="edit" size="sm" /></app-bronco-button>
            <app-bronco-button variant="icon" size="sm" ariaLabel="Delete environment" (click)="deleteEnvironment(env)"><app-icon name="delete" size="sm" /></app-bronco-button>
          </div>
          @if (env.description) { <p class="env-desc">{{ env.description }}</p> }
          @if (env.operationalInstructions) {
            <pre class="env-instructions">{{ truncate(env.operationalInstructions) }}</pre>
          }
        </app-card>
      } @empty {
        <p class="empty">No environments configured. Add environments (e.g. Production, Development) to group systems, repos, and integrations.</p>
      }
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        [title]="editing() ? 'Edit Environment' : 'Add Environment'"
        maxWidth="650px"
        (openChange)="showDialog.set(false)">
        <app-client-environment-dialog-content
          [clientId]="clientId()"
          [environment]="editing() ?? undefined"
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

    .env-card {
      margin-bottom: 12px;
    }

    .env-card.inactive-card {
      opacity: 0.6;
    }

    .env-header {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .env-icon {
      font-size: 16px;
      line-height: 1;
      color: var(--color-info);
    }

    .env-name {
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-primary);
    }

    .chip {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-family: var(--font-primary);
      white-space: nowrap;
    }

    .chip-tag {
      background: var(--bg-muted);
      color: var(--text-secondary);
    }

    .chip-default {
      background: var(--color-info-subtle);
      color: var(--color-info);
    }

    .spacer { flex: 1; }

    .env-desc {
      color: var(--text-secondary);
      font-family: var(--font-primary);
      font-size: 13px;
      margin: 10px 0 4px;
      line-height: 1.5;
    }

    .env-instructions {
      background: var(--bg-code);
      color: var(--text-code);
      padding: 10px 14px;
      border-radius: var(--radius-md);
      font-size: 12px;
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      white-space: pre-wrap;
      word-wrap: break-word;
      max-height: 200px;
      overflow-y: auto;
      margin: 10px 0 0;
    }

    .empty {
      color: var(--text-tertiary);
      font-family: var(--font-primary);
      font-size: 14px;
      padding: 32px 16px;
      text-align: center;
    }
  `],
})
export class ClientEnvironmentsTabComponent implements OnInit {
  clientId = input.required<string>();

  private envService = inject(ClientEnvironmentService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  environments = signal<ClientEnvironment[]>([]);
  showDialog = signal(false);
  editing = signal<ClientEnvironment | null>(null);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.envService.getEnvironments(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(e => this.environments.set(e));
  }

  openAddDialog(): void {
    this.editing.set(null);
    this.showDialog.set(true);
  }

  openEditDialog(env: ClientEnvironment): void {
    this.editing.set(env);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }

  toggleEnvironment(env: ClientEnvironment, checked: boolean): void {
    this.environments.update(list => list.map(e => e.id === env.id ? { ...e, isActive: checked } : e));
    this.envService.updateEnvironment(this.clientId(), env.id, { isActive: checked })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.toast.success(`Environment ${checked ? 'enabled' : 'disabled'}`),
        error: (err) => {
          this.environments.update(list => list.map(e => e.id === env.id ? { ...e, isActive: !checked } : e));
          this.toast.error(err.error?.error ?? err.error?.message ?? 'Toggle failed');
        },
      });
  }

  deleteEnvironment(env: ClientEnvironment): void {
    if (!confirm(`Delete environment "${env.name}"? Linked integrations, repos, and systems will be unlinked.`)) return;
    this.envService.deleteEnvironment(this.clientId(), env.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Environment deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.error ?? err.error?.message ?? 'Delete failed'),
      });
  }

  truncate(text: string, max = 200): string {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }
}
