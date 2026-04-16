import { Component, computed, contentChildren, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TabComponent } from './tab.component';

@Component({
  selector: 'app-tab-group',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <div class="tab-group">
      <div class="tab-bar" role="tablist">
        @for (tab of tabs(); track $index) {
          <button
            class="tab-btn"
            role="tab"
            [attr.aria-selected]="$index === selectedIndex()"
            [attr.tabindex]="$index === selectedIndex() ? 0 : -1"
            [class.active]="$index === selectedIndex()"
            (click)="selectTab($index)">
            {{ tab.label() }}
          </button>
        }
      </div>
      <div class="tab-content" role="tabpanel">
        @if (activeTab()) {
          <ng-container [ngTemplateOutlet]="activeTab()!.contentTpl()" />
        }
      </div>
    </div>
  `,
  styles: [`
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
      white-space: nowrap;
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

    /*
     * Mobile (< 768px): tab rows with many items (ticket detail ~10, client
     * detail ~10) overflow the viewport. Switch the bar to horizontal
     * scrolling so every tab stays reachable. Momentum scrolling keeps it
     * feeling native. Scrollbar hidden — the active underline is the
     * position cue. Desktop behavior above is untouched.
     */
    @media (max-width: 767.98px) {
      .tab-bar {
        overflow-x: auto;
        overflow-y: hidden;
        flex-wrap: nowrap;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .tab-bar::-webkit-scrollbar {
        display: none;
      }
      .tab-btn {
        flex-shrink: 0;
      }
    }
  `],
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
