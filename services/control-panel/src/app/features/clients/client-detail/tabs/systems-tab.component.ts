import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { System } from '../../../../core/services/client.service';
import { SystemService } from '../../../../core/services/system.service';
import {
  BroncoButtonComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
} from '../../../../shared/components/index.js';
import { SystemDialogComponent } from '../../../systems/system-dialog.component';

@Component({
  selector: 'app-client-systems-tab',
  standalone: true,
  imports: [
    BroncoButtonComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    SystemDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Database Systems</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openDialog()">+ Add System</app-bronco-button>
      </div>

      <app-data-table
        [data]="systems()"
        [trackBy]="trackById"
        [rowClickable]="true"
        (rowClick)="editSystem($event)"
        emptyMessage="No systems configured.">
        <app-data-column key="name" header="Name" [sortable]="false">
          <ng-template #cell let-s>{{ s.name }}</ng-template>
        </app-data-column>
        <app-data-column key="dbEngine" header="Engine" [sortable]="false">
          <ng-template #cell let-s>
            <span class="chip chip-engine">{{ s.dbEngine }}</span>
          </ng-template>
        </app-data-column>
        <app-data-column key="host" header="Host" [sortable]="false">
          <ng-template #cell let-s>
            <code class="host">{{ s.host }}:{{ s.port }}</code>
          </ng-template>
        </app-data-column>
        <app-data-column key="environment" header="Env" [sortable]="false">
          <ng-template #cell let-s>{{ s.environment }}</ng-template>
        </app-data-column>
        <app-data-column key="status" header="Status" [sortable]="false">
          <ng-template #cell let-s>
            <span class="chip" [class.chip-active]="s.isActive" [class.chip-inactive]="!s.isActive">
              {{ s.isActive ? 'Active' : 'Inactive' }}
            </span>
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    @if (showDialog()) {
      <app-dialog [open]="true" [title]="editingSystem() ? 'Edit Database System' : 'Add Database System'" maxWidth="600px" (openChange)="showDialog.set(false)">
        <app-system-dialog-content
          [clientId]="clientId()"
          [system]="editingSystem()"
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
    .chip-engine {
      background: var(--bg-active);
      color: var(--accent);
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 11px;
    }
    .chip-active {
      background: var(--color-success-subtle);
      color: var(--color-success);
    }
    .chip-inactive {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }

    .host {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 13px;
      color: var(--text-secondary);
      background: var(--bg-code);
      padding: 1px 6px;
      border-radius: var(--radius-sm);
    }
  `],
})
export class ClientSystemsTabComponent implements OnInit {
  clientId = input.required<string>();

  private systemService = inject(SystemService);
  private destroyRef = inject(DestroyRef);

  systems = signal<System[]>([]);
  showDialog = signal(false);
  editingSystem = signal<System | undefined>(undefined);

  trackById = (s: System): string => s.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.systemService.getSystems(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(s => this.systems.set(s));
  }

  openDialog(): void {
    this.editingSystem.set(undefined);
    this.showDialog.set(true);
  }

  editSystem(system: System): void {
    this.editingSystem.set(system);
    this.showDialog.set(true);
  }

  onSaved(): void {
    this.showDialog.set(false);
    this.load();
  }
}
