import { Component, inject, input, output } from '@angular/core';
import { CommonModule, DecimalPipe, JsonPipe } from '@angular/common';
import { DialogComponent, BroncoButtonComponent, IconComponent } from '../../../shared/components/index.js';
import { TicketService } from '../../../core/services/ticket.service.js';
import type { TraceNode, TraceToolPill } from './analysis-trace.types.js';
import { firstUserMessageText, responseText } from './analysis-trace.merge.js';

export interface ExpandPayload {
  kind: 'node' | 'pill';
  node?: TraceNode;
  pill?: TraceToolPill;
}

@Component({
  selector: 'app-analysis-trace-expand-dialog',
  standalone: true,
  imports: [CommonModule, DecimalPipe, JsonPipe, DialogComponent, BroncoButtonComponent, IconComponent],
  template: `
    <app-dialog [open]="true" [title]="title()" maxWidth="820px" (openChange)="closed.emit()">
      @if (payload()?.kind === 'node') {
        @let n = payload()!.node!;
        <div class="expand-sections">
          <div class="expand-row">
            <span class="meta-chip">{{ n.entry.taskType }}</span>
            @if (n.entry.model) { <code class="meta-chip model-chip">{{ n.entry.model }}</code> }
            @if (n.entry.inputTokens != null) { <span class="meta-chip token-chip">{{ n.entry.inputTokens | number }}in / {{ n.entry.outputTokens | number }}out</span> }
            @if (n.entry.costUsd != null) { <span class="meta-chip cost-chip">\${{ n.entry.costUsd | number:'1.4-4' }}</span> }
          </div>

          @if (promptText(n); as prompt) {
            <section class="expand-section">
              <header>
                <span class="expand-label">Prompt</span>
                <app-bronco-button variant="ghost" size="sm" (click)="copy(prompt)">
                  <app-icon name="copy" size="xs" /> Copy
                </app-bronco-button>
              </header>
              <pre class="expand-pre">{{ prompt }}</pre>
            </section>
          }

          @if (respText(n); as resp) {
            <section class="expand-section">
              <header>
                <span class="expand-label">Response</span>
                <app-bronco-button variant="ghost" size="sm" (click)="copy(resp)">
                  <app-icon name="copy" size="xs" /> Copy
                </app-bronco-button>
              </header>
              <pre class="expand-pre">{{ resp }}</pre>
            </section>
          }

          @for (cont of n.continuations; track $index) {
            <section class="expand-section">
              <header>
                <span class="expand-label">Continuation {{ $index + 1 }}</span>
                <app-bronco-button variant="ghost" size="sm" (click)="copy(cont)">
                  <app-icon name="copy" size="xs" /> Copy
                </app-bronco-button>
              </header>
              <pre class="expand-pre">{{ cont }}</pre>
            </section>
          }

          @if (rawJsonVisible) {
            <section class="expand-section">
              <header><span class="expand-label">Raw row JSON</span></header>
              <pre class="expand-pre">{{ n.entry | json }}</pre>
            </section>
          }
          <app-bronco-button variant="ghost" size="sm" (click)="rawJsonVisible = !rawJsonVisible">
            {{ rawJsonVisible ? 'Hide' : 'Show' }} raw row JSON
          </app-bronco-button>
        </div>
      } @else if (payload()?.kind === 'pill') {
        @let p = payload()!.pill!;
        <div class="expand-sections">
          <div class="expand-row">
            <code class="meta-chip model-chip">{{ p.toolName }}</code>
            @if (p.durationMs != null) { <span class="meta-chip duration-chip">{{ p.durationMs | number }}ms</span> }
            @if (p.truncated) { <span class="meta-chip truncated-chip">truncated</span> }
            @if (p.isError) { <span class="meta-chip err-chip">error</span> }
          </div>

          @if (p.input) {
            <section class="expand-section">
              <header><span class="expand-label">Input</span></header>
              <pre class="expand-pre">{{ p.input | json }}</pre>
            </section>
          }

          @if (p.result) {
            <section class="expand-section">
              <header>
                <span class="expand-label">Tool result</span>
                <app-bronco-button variant="ghost" size="sm" (click)="copy(p.result!)">
                  <app-icon name="copy" size="xs" /> Copy
                </app-bronco-button>
              </header>
              <pre class="expand-pre">{{ p.result }}</pre>
            </section>
          }

          @if (p.artifactId) {
            <a class="artifact-download" [href]="ticketService.getArtifactDownloadUrl(p.artifactId)" download>
              <app-icon name="download" size="sm" /> Download full output artifact
            </a>
          }
        </div>
      }
    </app-dialog>
  `,
  styles: [`
    .expand-sections { display: flex; flex-direction: column; gap: 10px; }
    .expand-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .expand-section { border: 1px solid var(--border-light); border-radius: 4px; overflow: hidden; }
    .expand-section header { display: flex; justify-content: space-between; align-items: center; background: var(--bg-muted); padding: 4px 8px; }
    .expand-label { font-size: 11px; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; }
    .expand-pre { margin: 0; padding: 8px 10px; font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow-y: auto; }
    .meta-chip { font-size: 11px; padding: 1px 6px; border-radius: 10px; white-space: nowrap; background: var(--bg-muted); color: var(--text-primary); }
    .model-chip { font-family: monospace; }
    .token-chip { background: var(--color-warning-subtle); color: var(--color-warning); }
    .cost-chip { background: var(--color-success-subtle); color: var(--color-success); }
    .duration-chip { background: var(--color-error-subtle); color: var(--color-error); }
    .truncated-chip { background: var(--color-warning-subtle); color: var(--color-warning); }
    .err-chip { background: var(--color-error-subtle); color: var(--color-error); }
    .artifact-download {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 10px; border: 1px solid var(--color-info); color: var(--color-info);
      border-radius: 4px; font-size: 13px; text-decoration: none; align-self: flex-start;
    }
    .artifact-download:hover { background: var(--color-info-subtle); }
  `],
})
export class AnalysisTraceExpandDialogComponent {
  readonly ticketService = inject(TicketService);

  payload = input.required<ExpandPayload | null>();
  closed = output<void>();

  rawJsonVisible = false;

  title(): string {
    const p = this.payload();
    if (!p) return '';
    if (p.kind === 'node') {
      const entry = p.node?.entry;
      return entry ? `${entry.taskType ?? 'AI call'} · ${entry.model ?? ''}` : 'AI call';
    }
    return `Tool call: ${p.pill?.toolName ?? ''}`;
  }

  promptText(n: TraceNode): string | null {
    return firstUserMessageText(n.entry);
  }

  respText(n: TraceNode): string {
    return responseText(n.entry);
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable in sandboxed environments
    }
  }
}
