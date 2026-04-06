import { Component } from '@angular/core';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  template: `
    <div class="toolbar">
      <ng-content />
    </div>
  `,
  styles: `
    :host { display: block; }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 0;
      flex-wrap: wrap;
    }

    :host ::ng-deep .toolbar-spacer {
      flex: 1 1 auto;
    }
  `,
})
export class ToolbarComponent {}
