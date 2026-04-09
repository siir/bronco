import { Component, contentChild, input, TemplateRef } from '@angular/core';

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
  headerTpl = contentChild<TemplateRef<unknown>>('header');
  cellTpl = contentChild.required<TemplateRef<{ $implicit: T }>>('cell');
}
