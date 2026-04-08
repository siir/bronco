import { Component, computed, input } from '@angular/core';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { ICON_REGISTRY, type IconName } from './icon-registry.js';

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Bronco icon component.
 *
 * Wraps Font Awesome's <fa-icon> behind a stable, semantic-name API. The
 * actual icon library (currently FA Pro Sharp Light via @awesome.me kit)
 * is hidden from consumers — they reference icons by Bronco semantic name
 * via <app-icon name="edit" />.
 *
 * Sizes map to fixed pixel values rather than FA's relative scale, so
 * icons render consistently regardless of surrounding font size.
 *
 * Usage:
 *   <app-icon name="edit" />
 *   <app-icon name="chevron-down" size="sm" />
 *   <app-icon name="warning" size="lg" ariaLabel="Critical alert" />
 */
@Component({
  selector: 'app-icon',
  standalone: true,
  imports: [FaIconComponent],
  template: `
    <fa-icon
      class="bronco-icon"
      [class]="'icon-' + size()"
      [icon]="iconRef()"
      [fixedWidth]="fixedWidth()"
      [attr.aria-hidden]="ariaLabel() ? null : true"
      [attr.aria-label]="ariaLabel() || null"
      [attr.role]="ariaLabel() ? 'img' : null" />
  `,
  styles: [`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .bronco-icon {
      color: currentColor;
      line-height: 1;
    }

    .icon-xs :is(svg) { width: 10px; height: 10px; }
    .icon-sm :is(svg) { width: 12px; height: 12px; }
    .icon-md :is(svg) { width: 16px; height: 16px; }
    .icon-lg :is(svg) { width: 20px; height: 20px; }
    .icon-xl :is(svg) { width: 24px; height: 24px; }
  `],
})
export class IconComponent {
  name = input.required<IconName>();
  size = input<IconSize>('md');
  fixedWidth = input<boolean>(false);
  ariaLabel = input<string>('');

  iconRef = computed(() => ICON_REGISTRY[this.name()]);
}
