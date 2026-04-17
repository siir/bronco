import { Component, computed, contentChild, contentChildren, inject, input, output, TemplateRef } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { DataTableColumnComponent } from './data-table-column.component.js';
import { IconComponent } from './icon.component.js';
import { ViewportService } from '../../core/services/viewport.service.js';

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [NgTemplateOutlet, IconComponent],
  template: `
    <div class="table-container" [class.card-mode]="viewport.isMobile()">
      @if (data().length === 0) {
        <div class="table-empty">{{ emptyMessage() }}</div>
      } @else if (viewport.isMobile()) {
        <div class="card-list">
          @for (row of data(); track trackBy()(row)) {
            <div
              class="card"
              [class.clickable]="rowClickable()"
              [class.expanded]="expandedRow() === row"
              [attr.role]="rowClickable() ? 'button' : null"
              [attr.tabindex]="rowClickable() ? 0 : null"
              (click)="rowClickable() ? rowClick.emit(row) : null"
              (keydown.enter)="rowClickable() ? rowClick.emit(row) : null"
              (keydown.space)="rowClickable() ? onRowSpace($event, row) : null">
              @for (col of primaryCols(); track col.key()) {
                <div class="card-primary">
                  <ng-container [ngTemplateOutlet]="col.cellTpl()" [ngTemplateOutletContext]="{ $implicit: row }" />
                </div>
              }
              @if (subtitleTpl()) {
                <div class="card-subtitle">
                  <ng-container [ngTemplateOutlet]="subtitleTpl()!" [ngTemplateOutletContext]="{ $implicit: row }" />
                </div>
              }
              @if (secondaryCols().length > 0) {
                <div class="card-rows">
                  @for (col of secondaryCols(); track col.key()) {
                    <div class="card-row">
                      <span class="card-label">{{ col.header() }}</span>
                      <span class="card-value">
                        <ng-container [ngTemplateOutlet]="col.cellTpl()" [ngTemplateOutletContext]="{ $implicit: row }" />
                      </span>
                    </div>
                  }
                </div>
              }
              @if (expandedRow() === row && expandedTpl()) {
                <div class="card-expanded">
                  <ng-container [ngTemplateOutlet]="expandedTpl()!" [ngTemplateOutletContext]="{ $implicit: row }" />
                </div>
              }
            </div>
          }
        </div>
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
                [class.expanded-row]="expandedRow() === row"
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
              @if (subtitleTpl()) {
                <tr class="subtitle-row" [class.clickable]="rowClickable()" (click)="rowClickable() ? rowClick.emit(row) : null">
                  <td [attr.colspan]="columns().length">
                    <ng-container [ngTemplateOutlet]="subtitleTpl()!" [ngTemplateOutletContext]="{ $implicit: row }" />
                  </td>
                </tr>
              }
              @if (expandedRow() === row && expandedTpl()) {
                <tr class="expanded-detail-row">
                  <td [attr.colspan]="columns().length">
                    <ng-container [ngTemplateOutlet]="expandedTpl()!" [ngTemplateOutletContext]="{ $implicit: row }" />
                  </td>
                </tr>
              }
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
      overflow: auto;
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

    tr.clickable:hover,
    tr.clickable:hover + .subtitle-row,
    tr.clickable:has(+ .subtitle-row:hover) {
      background: var(--bg-hover);
    }

    .subtitle-row.clickable:hover {
      background: var(--bg-hover);
    }

    tr:has(+ .subtitle-row) td {
      border-bottom: none;
      padding-bottom: 4px;
    }

    .subtitle-row td {
      padding: 0 16px 14px;
      font-size: 12px;
      color: var(--text-tertiary);
      border-bottom: 1px solid var(--border-light);
    }

    .subtitle-row:has(td:empty) {
      display: none;
    }

    tr.expanded-row td {
      border-bottom-color: transparent;
    }

    .expanded-detail-row td {
      padding: 0 16px 16px;
      border-bottom: 1px solid var(--border-light);
    }

    .expanded-detail-row:hover {
      background: transparent;
    }

    .table-empty {
      padding: 48px 24px;
      text-align: center;
      font-family: var(--font-primary);
      font-size: 14px;
      color: var(--text-tertiary);
    }

    /*
     * Mobile card variant.
     *
     * When viewport.isMobile() is true, rows are rendered as stacked cards
     * (.card-list / .card). The entire styling for that path lives below
     * — the desktop table styles above are untouched. The .card-mode
     * container also drops the outer card chrome (background, shadow,
     * border-radius) so each row-card carries its own elevation, matching
     * platform-native list patterns.
     */
    .table-container.card-mode {
      background: transparent;
      box-shadow: none;
      border-radius: 0;
      overflow: visible;
    }

    .card-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-lg);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      box-shadow: var(--shadow-card);
      font-family: var(--font-primary);
      transition: background 120ms ease;
    }

    .card.clickable {
      cursor: pointer;
      min-height: 44px;
    }

    .card.clickable:hover,
    .card.clickable:focus-visible {
      background: var(--bg-hover);
      outline: none;
    }

    .card.clickable:focus-visible {
      box-shadow: 0 0 0 2px var(--focus-ring);
    }

    .card-primary {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.3;
      word-break: break-word;
    }

    .card-subtitle {
      font-size: 12px;
      color: var(--text-tertiary);
      line-height: 1.4;
    }

    .card-rows {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .card-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .card-label {
      color: var(--text-tertiary);
      font-size: 12px;
      flex-shrink: 0;
    }

    .card-value {
      text-align: right;
      min-width: 0;
      word-break: break-word;
    }

    .card-expanded {
      margin-top: 4px;
      padding-top: 8px;
      border-top: 1px solid var(--border-light);
    }
  `],
})
export class DataTableComponent<T = unknown> {
  readonly viewport = inject(ViewportService);

  data = input.required<T[]>();
  trackBy = input.required<(item: T) => string>();
  sortColumn = input<string>('');
  sortDirection = input<'asc' | 'desc'>('asc');
  rowClickable = input<boolean>(true);
  emptyMessage = input<string>('No data');
  expandedRow = input<T | null>(null);

  rowClick = output<T>();
  sortChange = output<{ column: string; direction: 'asc' | 'desc' }>();

  columns = contentChildren(DataTableColumnComponent);
  expandedTpl = contentChild<TemplateRef<{ $implicit: T }>>('expandedRow');
  subtitleTpl = contentChild<TemplateRef<unknown>>('subtitle');

  readonly primaryCols = computed(() =>
    this.columns().filter(c => c.mobilePriority() === 'primary'),
  );
  readonly secondaryCols = computed(() =>
    this.columns().filter(c => c.mobilePriority() === 'secondary'),
  );

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
