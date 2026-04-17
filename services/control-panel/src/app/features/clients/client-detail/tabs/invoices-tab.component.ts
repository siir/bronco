import { Component, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Invoice, InvoiceService } from '../../../../core/services/invoice.service.js';
import { ToastService } from '../../../../core/services/toast.service.js';
import {
  BroncoButtonComponent,
  DataTableComponent,
  DataTableColumnComponent,
  DialogComponent,
  IconComponent,
} from '../../../../shared/components/index.js';
import { GenerateInvoiceDialogComponent } from '../../generate-invoice-dialog.component.js';

@Component({
  selector: 'app-client-invoices-tab',
  standalone: true,
  imports: [
    DatePipe,
    DecimalPipe,
    BroncoButtonComponent,
    DataTableComponent,
    DataTableColumnComponent,
    DialogComponent,
    IconComponent,
    GenerateInvoiceDialogComponent,
  ],
  template: `
    <div class="tab-section">
      <div class="section-header">
        <h3 class="section-title">Invoices</h3>
        <app-bronco-button variant="primary" size="sm" (click)="openGenerateDialog()">+ Generate Invoice</app-bronco-button>
      </div>

      <app-data-table
        [data]="invoices()"
        [trackBy]="trackById"
        [rowClickable]="false"
        emptyMessage="No invoices generated yet.">
        <app-data-column key="invoiceNumber" header="#" [sortable]="false" width="80px">
          <ng-template #cell let-inv>{{ inv.invoiceNumber }}</ng-template>
        </app-data-column>
        <app-data-column key="period" header="Period" [sortable]="false" width="220px">
          <ng-template #cell let-inv>
            {{ inv.periodStart | date:'mediumDate' }} – {{ inv.periodEnd | date:'mediumDate' }}
          </ng-template>
        </app-data-column>
        <app-data-column key="requests" header="Requests" [sortable]="false" width="100px">
          <ng-template #cell let-inv>{{ inv.requestCount }}</ng-template>
        </app-data-column>
        <app-data-column key="totalBilled" header="Total Billed" [sortable]="false" width="120px">
          <ng-template #cell let-inv>\${{ inv.totalBilledCostUsd | number:'1.2-2' }}</ng-template>
        </app-data-column>
        <app-data-column key="invoiceStatus" header="Status" [sortable]="false" width="100px">
          <ng-template #cell let-inv>
            <span class="chip" [class.chip-final]="inv.status === 'final'" [class.chip-draft]="inv.status !== 'final'">
              {{ inv.status }}
            </span>
          </ng-template>
        </app-data-column>
        <app-data-column key="invoiceActions" header="" [sortable]="false" width="100px">
          <ng-template #cell let-inv>
            <div class="row-actions">
              <a class="row-action-link"
                 [href]="getDownloadUrl(inv.id)"
                 target="_blank"
                 rel="noopener noreferrer"
                 aria-label="Download PDF"
                 title="Download PDF"><app-icon name="download" size="sm" /></a>
              <app-bronco-button variant="icon" size="sm" ariaLabel="Delete invoice" (click)="deleteInvoice(inv)"><app-icon name="delete" size="sm" /></app-bronco-button>
            </div>
          </ng-template>
        </app-data-column>
      </app-data-table>
    </div>

    @if (showDialog()) {
      <app-dialog
        [open]="true"
        title="Generate Invoice"
        maxWidth="400px"
        (openChange)="showDialog.set(false)">
        <app-generate-invoice-dialog-content
          [clientId]="clientId()"
          (generated)="onGenerated()"
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
      text-transform: capitalize;
    }
    .chip-final {
      background: var(--color-success-subtle);
      color: var(--color-success);
    }
    .chip-draft {
      background: var(--bg-muted);
      color: var(--text-tertiary);
    }

    .row-actions {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }

    .row-action-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: var(--radius-sm);
      color: var(--text-tertiary);
      text-decoration: none;
      font-size: 14px;
      transition: background 120ms ease, color 120ms ease;
    }
    .row-action-link:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }
  `],
})
export class ClientInvoicesTabComponent implements OnInit {
  clientId = input.required<string>();

  private invoiceService = inject(InvoiceService);
  private toast = inject(ToastService);
  private destroyRef = inject(DestroyRef);

  invoices = signal<Invoice[]>([]);
  showDialog = signal(false);

  trackById = (i: Invoice): string => i.id;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.invoiceService.getInvoices(this.clientId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(i => this.invoices.set(i));
  }

  openGenerateDialog(): void {
    this.showDialog.set(true);
  }

  onGenerated(): void {
    this.showDialog.set(false);
    this.load();
  }

  getDownloadUrl(invoiceId: string): string {
    return this.invoiceService.getDownloadUrl(this.clientId(), invoiceId);
  }

  deleteInvoice(inv: Invoice): void {
    if (!confirm(`Delete invoice #${inv.invoiceNumber}?`)) return;
    this.invoiceService.deleteInvoice(this.clientId(), inv.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.toast.success('Invoice deleted');
          this.load();
        },
        error: (err) => this.toast.error(err.error?.message ?? err.error?.error ?? 'Delete failed'),
      });
  }
}
