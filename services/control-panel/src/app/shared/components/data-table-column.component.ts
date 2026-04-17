import { Component, contentChild, input, TemplateRef } from '@angular/core';

/**
 * Mobile card-layout priority for a `<app-data-column>`.
 *
 * Used by `DataTableComponent` when `viewport.isMobile()` to render rows as
 * cards instead of a table:
 * - `'primary'`   — column's cell template renders as the card's heading
 *                   (no label prefix). Use for the entity's identifying field
 *                   (e.g. ticket subject, client name).
 * - `'secondary'` — column's cell template renders as a label/value row
 *                   under the heading. This is the default and works for
 *                   most fields without per-page tuning.
 * - `'hidden'`    — column is omitted on mobile. Use for low-signal columns
 *                   like timestamps, source codes, action buttons that don't
 *                   make sense in a card.
 */
export type DataTableMobilePriority = 'primary' | 'secondary' | 'hidden';

@Component({
  selector: 'app-data-column',
  standalone: true,
  template: '',
})
export class DataTableColumnComponent<T = unknown> {
  key = input.required<string>();
  header = input.required<string>();
  sortable = input<boolean>(true);
  width = input<string>('');
  mobilePriority = input<DataTableMobilePriority>('secondary');
  headerTpl = contentChild<TemplateRef<unknown>>('header');
  cellTpl = contentChild.required<TemplateRef<{ $implicit: T }>>('cell');
}
