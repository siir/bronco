import { Component } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { SidebarComponent } from './sidebar.component.js';

/**
 * Mobile drawer wrapper around `SidebarComponent`.
 *
 * Attached to a CDK Overlay by `AppShellComponent` when
 * `viewport.isCompactLayout()` is true (< 1200px) and the drawer is open.
 * Applies a focus trap so keyboard Tab stays
 * within the drawer while open. The drawer chrome (width, slide animation,
 * tap-target overrides) is styled globally via `.sidebar-drawer-pane` in
 * styles.scss — `SidebarComponent` itself stays untouched.
 */
@Component({
  selector: 'app-sidebar-drawer',
  standalone: true,
  imports: [SidebarComponent, A11yModule],
  template: `
    <div class="sidebar-drawer-host" cdkTrapFocus [cdkTrapFocusAutoCapture]="true">
      <app-sidebar />
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .sidebar-drawer-host { height: 100%; }
  `],
})
export class SidebarDrawerComponent {}
