import { Component, computed, contentChildren, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TabComponent } from './tab.component.js';

@Component({
  selector: 'app-tab-group',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <div class="tab-group">
      <div class="tab-bar">
        @for (tab of tabs(); track $index) {
          <button
            class="tab-btn"
            [class.active]="$index === selectedIndex()"
            (click)="selectTab($index)">
            {{ tab.label() }}
          </button>
        }
      </div>
      <div class="tab-content">
        @if (activeTab()) {
          <ng-container [ngTemplateOutlet]="activeTab()!.contentTpl()" />
        }
      </div>
    </div>
  `,
  styles: `
    .tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 1px solid var(--border-light);
      padding: 0;
    }

    .tab-btn {
      padding: 10px 14px;
      font-family: var(--font-primary);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-tertiary);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      cursor: pointer;
      transition: all 120ms ease;
    }

    .tab-btn:hover {
      color: var(--text-secondary);
    }

    .tab-btn.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent);
    }

    .tab-content {
      padding: 16px 0 0;
    }
  `,
})
export class TabGroupComponent {
  selectedIndex = input<number>(0);
  selectedIndexChange = output<number>();

  tabs = contentChildren(TabComponent);
  activeTab = computed(() => this.tabs()[this.selectedIndex()] ?? null);

  selectTab(index: number): void {
    this.selectedIndexChange.emit(index);
  }
}
