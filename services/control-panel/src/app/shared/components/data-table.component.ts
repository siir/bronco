import { Component, contentChildren, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DataTableColumnComponent } from './data-table-column.component';
import { IconComponent } from './icon.component';

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [NgTemplateOutlet, IconComponent],
  template: `
    <div class="table-container">
      @if (data().length === 0) {
        <div class="table-empty">{{ emptyMessage() }}</div>
      } @else {
        <table>
          <thead>
            <tr>
              @for (col of columns(); track col.key()) {
                <th
                  [style.width]="col.width()"
                  [class.sortable]="col.sortable()"
                  [class.sorted]="sortColumn() === col.key()"
                  [attr.tabindex]="col.sortable() ? 0 : null"
                  [attr.aria-sort]="sortColumn() === col.key() ? (sortDirection() === 'asc' ? 'ascending' : 'descending') : null"
                  (click)="col.sortable() ? onSort(col.key()) : null"
                  (keydown.enter)="col.sortable() ? onSortKey($event, col.key()) : null"
                  (keydown.space)="col.sortable() ? onSortKey($event, col.key()) : null">
                  @if (col.headerTpl()) {
                    <ng-container [ngTemplateOutlet]="col.headerTpl()!" />
                  } @else {
                    {{ col.header() }}
                  }
                  @if (col.sortable() && sortColumn() === col.key()) {
                    <app-icon class="sort-indicator" [name]="sortDirection() === 'asc' ? 'chevron-up' : 'chevron-down'" size="xs" />
                  }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of data(); track trackBy()(row)) {
              <tr
                [class.clickable]="rowClickable()"
                [attr.tabindex]="rowClickable() ? 0 : null"
                (click)="rowClickable() ? rowClick.emit(row) : null"
                (keydown.enter)="rowClickable() ? rowClick.emit(row) : null"
                (keydown.space)="rowClickable() ? onRowSpace($event, row) : null">
                @for (col of columns(); track col.key()) {
                  <td [style.width]="col.width()">
                    <ng-container [ngTemplateOutlet]="col.cellTpl()" [ngTemplateOutletContext]="{ $implicit: row }" />
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: [`
    .table-container {
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: var(--shadow-card);
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead th {
      text-align: left;
      padding: 10px 16px;
      font-family: var(--font-primary);
      font-size: 12px;
      font-weight: 500;
      color: var(--text-tertiary);
      border-bottom: 1px solid var(--border-light);
      user-select: none;
    }

    th.sortable {
      cursor: pointer;
    }

    th.sortable:hover {
      color: var(--text-secondary);
    }

    th.sorted {
      color: var(--text-primary);
    }

    .sort-indicator {
      font-size: 9px;
      margin-left: 4px;
      color: var(--text-tertiary);
    }

    tbody td {
      padding: 14px 16px;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-light);
    }

    tbody tr:last-child td {
      border-bottom: none;
    }

    tr.clickable {
      cursor: pointer;
      transition: background 120ms ease;
    }

    tr.clickable:hover {
      background: var(--bg-hover);
    }

    .table-empty {
      padding: 48px 24px;
      text-align: center;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-tertiary);
    }
  `],
})
export class DataTableComponent<T = unknown> {
  data = input.required<T[]>();
  trackBy = input.required<(item: T) => string>();
  sortColumn = input<string>('');
  sortDirection = input<'asc' | 'desc'>('asc');
  rowClickable = input<boolean>(true);
  emptyMessage = input<string>('No data');

  rowClick = output<T>();
  sortChange = output<{ column: string; direction: 'asc' | 'desc' }>();

  columns = contentChildren(DataTableColumnComponent);

  onSort(key: string): void {
    const direction = this.sortColumn() === key && this.sortDirection() === 'asc' ? 'desc' : 'asc';
    this.sortChange.emit({ column: key, direction });
  }

  onSortKey(event: Event, key: string): void {
    event.preventDefault();
    this.onSort(key);
  }

  onRowSpace(event: Event, row: T): void {
    event.preventDefault();
    this.rowClick.emit(row);
  }
}
