import { Component, input, TemplateRef, viewChild } from '@angular/core';

@Component({
  selector: 'app-tab',
  standalone: true,
  template: '<ng-template #content><ng-content /></ng-template>',
})
export class TabComponent {
  label = input.required<string>();
  contentTpl = viewChild.required<TemplateRef<unknown>>('content');
}
