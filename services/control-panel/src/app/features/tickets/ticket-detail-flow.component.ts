import { Component, input } from '@angular/core';
import { CardComponent } from '../../shared/components/index.js';

export interface FlowNode {
  label: string;
  icon: string;
  type: 'start' | 'action' | 'ai' | 'email' | 'status' | 'end';
  children?: FlowNode[];
}

@Component({
  selector: 'app-ticket-detail-flow',
  standalone: true,
  imports: [CardComponent],
  template: `
    <app-card padding="md" class="flow-card">
      <div class="card-title-row">
        <span class="card-title-icon" aria-hidden="true">&#9783;</span>
        <h3 class="card-title">Process Flow</h3>
      </div>
      <div class="flow-container">
        @for (node of nodes(); track node.type + ':' + node.label + ':' + $index; let i = $index) {
          <div class="flow-node flow-{{ node.type }}">
            <span class="flow-icon" aria-hidden="true">{{ glyphFor(node.icon) }}</span>
            <span class="flow-label">{{ node.label }}</span>
          </div>
          @if (node.children && node.children.length > 0) {
            <div class="flow-branch">
              @for (child of node.children; track child.type + ':' + child.label + ':' + $index; let j = $index) {
                <div class="flow-branch-row">
                  <div class="flow-connector"></div>
                  <div class="flow-node flow-{{ child.type }}">
                    <span class="flow-icon" aria-hidden="true">{{ glyphFor(child.icon) }}</span>
                    <span class="flow-label">{{ child.label }}</span>
                  </div>
                  @if (child.children && child.children.length > 0) {
                    @for (grandchild of child.children; track grandchild.type + ':' + grandchild.label + ':' + $index) {
                      <div class="flow-connector"></div>
                      <div class="flow-node flow-{{ grandchild.type }}">
                        <span class="flow-icon" aria-hidden="true">{{ glyphFor(grandchild.icon) }}</span>
                        <span class="flow-label">{{ grandchild.label }}</span>
                      </div>
                    }
                  }
                </div>
              }
            </div>
          }
          @if (i < nodes().length - 1 && !node.children?.length) {
            <span class="flow-arrow" aria-hidden="true">&rarr;</span>
          }
        }
      </div>
    </app-card>
  `,
  styles: [`
    :host {
      display: block;
      margin-bottom: 16px;
      font-family: var(--font-primary);
    }
    .card-title-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .card-title-icon {
      font-size: 18px;
      color: var(--text-tertiary);
    }
    .card-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .flow-container {
      display: flex;
      align-items: flex-start;
      gap: 4px;
      flex-wrap: wrap;
      padding: 8px 0;
      overflow-x: auto;
    }
    .flow-node {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: var(--radius-pill);
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
    }
    .flow-start  { background: var(--color-info-subtle);    color: var(--color-info); }
    .flow-action { background: var(--color-purple-subtle);  color: var(--color-purple); }
    .flow-ai     { background: var(--color-error-subtle);   color: var(--color-error); }
    .flow-email  { background: var(--color-success-subtle); color: var(--color-success); }
    .flow-status { background: var(--color-warning-subtle); color: var(--color-warning); }
    .flow-end    { background: var(--bg-muted);             color: var(--text-tertiary); }
    .flow-icon { font-size: 12px; }
    .flow-arrow {
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
      font-size: 16px;
    }
    .flow-branch {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-left: 8px;
      padding-left: 8px;
      border-left: 2px solid var(--border-light);
    }
    .flow-branch-row { display: flex; align-items: center; gap: 4px; }
    .flow-connector {
      width: 12px;
      height: 2px;
      background: var(--border-light);
    }
  `],
})
export class TicketDetailFlowComponent {
  nodes = input.required<FlowNode[]>();

  glyphFor(icon: string): string {
    const map: Record<string, string> = {
      email: '\u2709',
      send: '\u27a4',
      psychology: '\u26ac',
      lightbulb: '\u2731',
      swap_horiz: '\u21c4',
      account_tree: '\u22ee',
      sync: '\u21bb',
    };
    return map[icon] ?? '\u25CF';
  }
}
