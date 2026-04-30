import { Component, inject, input, output } from '@angular/core';
import { CommonModule, DecimalPipe, JsonPipe } from '@angular/common';
import { DialogComponent, BroncoButtonComponent, IconComponent } from '../../../shared/components/index.js';
import { TicketService } from '../../../core/services/ticket.service.js';
import type { TraceNode, TraceToolPill } from './analysis-trace.types.js';
import { effectivePrimaryResponse, firstUserMessageText, parsedMcpToolError } from './analysis-trace.merge.js';

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
          @if (n.entry.type === 'ai') {
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
          } @else {
            <div class="expand-row">
              <span class="meta-chip">{{ n.entry.type }}</span>
              @if (n.entry.level) { <span class="meta-chip">{{ n.entry.level }}</span> }
              @if (n.entry.service) { <span class="meta-chip">{{ n.entry.service }}</span> }
              @if (n.entry.durationMs != null) { <span class="meta-chip duration-chip">{{ n.entry.durationMs | number }}ms</span> }
            </div>

            @if (n.entry.message; as message) {
              <section class="expand-section">
                <header>
                  <span class="expand-label">Message</span>
                  <app-bronco-button variant="ghost" size="sm" (click)="copy(message)">
                    <app-icon name="copy" size="xs" /> Copy
                  </app-bronco-button>
                </header>
                <pre class="expand-pre">{{ message }}</pre>
              </section>
            }

            @if (n.entry.error) {
              <section class="expand-section">
                <header>
                  <span class="expand-label">Error</span>
                  <app-bronco-button variant="ghost" size="sm" (click)="copy(errorAsText(n))">
                    <app-icon name="copy" size="xs" /> Copy
                  </app-bronco-button>
                </header>
                <pre class="expand-pre">{{ n.entry.error }}</pre>
              </section>
            }

            @if (n.entry.context != null) {
              <section class="expand-section">
                <header>
                  <span class="expand-label">Context</span>
                  <app-bronco-button variant="ghost" size="sm" (click)="copyContext(n)">
                    <app-icon name="copy" size="xs" /> Copy
                  </app-bronco-button>
                </header>
                <pre class="expand-pre">{{ n.entry.context | json }}</pre>
              </section>
            }
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
        @let se = structuredError(p);
        <div class="expand-sections">
          <div class="expand-row">
            <code class="meta-chip model-chip">{{ p.toolName }}</code>
            @if (p.durationMs != null) { <span class="meta-chip duration-chip">{{ p.durationMs | number }}ms</span> }
            @if (p.truncated) { <span class="meta-chip truncated-chip">truncated</span> }
            @if (p.isError && !se) { <span class="meta-chip err-chip">error</span> }
            @if (se) {
              <span class="meta-chip err-chip">{{ se.errorClass }}</span>
              <span class="meta-chip" [class.retryable-chip]="se.retryable" [class.err-chip]="!se.retryable">
                {{ se.retryable ? 'retryable' : 'not retryable' }}
              </span>
            }
          </div>

          @if (se) {
            <section class="expand-section">
              <header><span class="expand-label">Error Details</span></header>
              <div class="structured-error-body">
                <div class="se-row"><span class="se-key">errorClass</span><code class="meta-chip err-chip">{{ se.errorClass }}</code></div>
                <div class="se-row"><span class="se-key">retryable</span><code class="meta-chip">{{ se.retryable }}</code></div>
                <div class="se-row se-row-block"><span class="se-key">message</span><span class="se-value">{{ se.message }}</span></div>
                <div class="se-row se-row-block"><span class="se-key">guidance</span><span class="se-value se-guidance">{{ se.guidance }}</span></div>
              </div>
            </section>
          }

          @if (p.input) {
            <section class="expand-section">
              <header><span class="expand-label">Input</span></header>
              <pre class="expand-pre">{{ p.input | json }}</pre>
            </section>
          }

          @if (p.result) {
            @if (se) {
              <details class="raw-json-details">
                <summary class="raw-json-summary">Show raw JSON</summary>
                <pre class="expand-pre">{{ p.result }}</pre>
              </details>
            } @else {
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
          }

          @if (p.artifactId) {
            <button type="button" class="artifact-download" (click)="ticketService.downloadArtifact(p.artifactId)">
              <app-icon name="download" size="sm" /> Download full output artifact
            </button>
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
      border-radius: 4px; font-size: 13px; background: none; cursor: pointer; font: inherit; align-self: flex-start;
    }
    .artifact-download:hover { background: var(--color-info-subtle); }
    .retryable-chip { background: var(--color-warning-subtle); color: var(--color-warning); }
    .structured-error-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    .se-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .se-row-block { align-items: flex-start; flex-direction: column; gap: 2px; }
    .se-key { font-weight: 700; color: var(--text-tertiary); font-size: 11px; min-width: 80px; }
    .se-value { font-size: 12px; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; }
    .se-guidance { color: var(--text-secondary); font-style: italic; }
    .raw-json-details { border: 1px solid var(--border-light); border-radius: 4px; overflow: hidden; }
    .raw-json-summary { font-size: 11px; font-weight: 700; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 8px; background: var(--bg-muted); cursor: pointer; }
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
      if (!entry) return 'Log entry';
      if (entry.type === 'ai') return `${entry.taskType ?? 'AI call'} · ${entry.model ?? ''}`;
      if (entry.type === 'error') return 'Error';
      if (entry.type === 'tool') return `Tool: ${entry.message ?? ''}`;
      if (entry.type === 'step') return `Step: ${entry.message ?? ''}`;
      return `Log · ${entry.level ?? ''}`;
    }
    return `Tool call: ${p.pill?.toolName ?? ''}`;
  }

  promptText(n: TraceNode): string | null {
    return firstUserMessageText(n.entry);
  }

  respText(n: TraceNode): string {
    // Mirrors the renderer (analysis-trace-node.component.ts:respLine) so the
    // expanded dialog surfaces a `primaryResponseOverride` promoted by Pass 2
    // when the row's own `responseText` is empty. Falls back to the entry's
    // raw response when no override is set. (#48 Item 3 — Copilot review)
    return effectivePrimaryResponse(n);
  }

  errorAsText(n: TraceNode): string {
    const err = n.entry.error;
    if (err === null || err === undefined) return '';
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err, null, 2);
    } catch {
      return String(err);
    }
  }

  copyContext(n: TraceNode): void {
    const ctx = n.entry.context;
    if (ctx === null || ctx === undefined) return;
    try {
      void this.copy(JSON.stringify(ctx, null, 2));
    } catch {
      void this.copy(String(ctx));
    }
  }

  structuredError(p: TraceToolPill) {
    return parsedMcpToolError(p.result ?? '');
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable in sandboxed environments
    }
  }
}
