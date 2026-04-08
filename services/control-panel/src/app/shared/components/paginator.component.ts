import { Component, computed, input, output } from '@angular/core';

export interface PaginatorPageEvent {
  pageSize: number;
  pageIndex: number;
  length: number;
}

@Component({
  selector: 'app-paginator',
  standalone: true,
  template: `
    <div class="paginator">
      <div class="paginator-section">
        <span class="paginator-label">Items per page:</span>
        <select
          class="page-size-select"
          [value]="pageSize()"
          (change)="onPageSizeChange($event)">
          @for (opt of pageSizeOptions(); track opt) {
            <option [value]="opt">{{ opt }}</option>
          }
        </select>
      </div>

      <div class="paginator-section paginator-nav">
        <button
          class="nav-btn"
          [disabled]="isFirstPage()"
          (click)="goToPage(0)"
          aria-label="First page">&laquo;</button>
        <button
          class="nav-btn"
          [disabled]="isFirstPage()"
          (click)="goToPage(pageIndex() - 1)"
          aria-label="Previous page">&lsaquo;</button>
        <span class="page-indicator">Page {{ pageIndex() + 1 }} of {{ totalPages() }}</span>
        <button
          class="nav-btn"
          [disabled]="isLastPage()"
          (click)="goToPage(pageIndex() + 1)"
          aria-label="Next page">&rsaquo;</button>
        <button
          class="nav-btn"
          [disabled]="isLastPage()"
          (click)="goToPage(totalPages() - 1)"
          aria-label="Last page">&raquo;</button>
      </div>

      <div class="paginator-section paginator-summary">
        <span class="paginator-label">{{ rangeLabel() }}</span>
      </div>
    </div>
  `,
  styles: [`
    .paginator {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
      gap: 16px;
      font-family: var(--font-primary);
    }

    .paginator-section {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .paginator-label {
      font-size: 12px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .page-size-select {
      appearance: none;
      background: var(--bg-card);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-sm);
      padding: 4px 24px 4px 8px;
      font-family: var(--font-primary);
      font-size: 12px;
      color: var(--text-primary);
      cursor: pointer;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%23999' d='M5 7L1 3h8z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }

    .page-size-select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring);
    }

    .paginator-nav {
      gap: 4px;
    }

    .nav-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-tertiary);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease;
    }

    .nav-btn:hover:not(:disabled) {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .nav-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .page-indicator {
      font-size: 12px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      padding: 0 4px;
      white-space: nowrap;
    }

    .paginator-summary {
      justify-content: flex-end;
    }
  `],
})
export class PaginatorComponent {
  length = input<number>(0);
  pageSize = input<number>(50);
  pageIndex = input<number>(0);
  pageSizeOptions = input<number[]>([25, 50, 100]);

  page = output<PaginatorPageEvent>();

  totalPages = computed(() => {
    const len = this.length();
    const size = this.pageSize();
    return size > 0 ? Math.max(1, Math.ceil(len / size)) : 1;
  });

  isFirstPage = computed(() => this.pageIndex() === 0);
  isLastPage = computed(() => this.pageIndex() >= this.totalPages() - 1);

  rangeLabel = computed(() => {
    const len = this.length();
    if (len === 0) return 'No items';
    const start = this.pageIndex() * this.pageSize() + 1;
    const end = Math.min((this.pageIndex() + 1) * this.pageSize(), len);
    return `Showing ${start}\u2013${end} of ${len}`;
  });

  goToPage(index: number): void {
    const clamped = Math.max(0, Math.min(index, this.totalPages() - 1));
    this.page.emit({
      pageSize: this.pageSize(),
      pageIndex: clamped,
      length: this.length(),
    });
  }

  onPageSizeChange(event: Event): void {
    const newSize = Number((event.target as HTMLSelectElement).value);
    this.page.emit({
      pageSize: newSize,
      pageIndex: 0,
      length: this.length(),
    });
  }
}
