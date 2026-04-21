import type { TicketEvent, UnifiedLogEntry } from '../../core/services/ticket.service.js';

export type AnalysisStrategy = 'flat' | 'orchestrated' | 'legacy';

export interface AnalysisStrategyStamp {
  strategy: AnalysisStrategy;
  models: string[];
  iterations: number;
  toolsUsedCount: number;
}

/**
 * Derive the strategy stamp for an analysis run.
 *
 * Resolution order for strategy:
 *   1. Root strategist row's `conversation_metadata.strategy`
 *      ('flat' | 'orchestrated') — populated by the ticket-analyzer.
 *   2. Fallback: latest `AI_ANALYSIS` TicketEvent's `metadata.phase`
 *      (`deep_analysis` → `flat`, `orchestrated_analysis` → `orchestrated`).
 *   3. Label `legacy` when neither signal is present.
 */
export function computeStrategyStamp(
  entries: UnifiedLogEntry[],
  events: TicketEvent[] | null = null,
): AnalysisStrategyStamp {
  const aiEntries = entries.filter(e => e.type === 'ai');

  // Models: distinct set across all AI rows.
  const modelSet = new Set<string>();
  for (const e of aiEntries) if (e.model) modelSet.add(e.model);

  // Iterations: max of orchestrationIteration or highest count of strategist calls.
  let iterations = 0;
  for (const e of aiEntries) {
    const meta = (e.conversationMetadata ?? {}) as Record<string, unknown>;
    const n = meta['orchestrationIteration'];
    if (typeof n === 'number' && n > iterations) iterations = n;
  }
  if (iterations === 0) {
    // Fall back to distinct strategist calls (non-sub-task AI rows with parent-free lineage).
    const strategistCount = aiEntries.filter(e => {
      const meta = (e.conversationMetadata ?? {}) as Record<string, unknown>;
      return !meta['isSubTask'] && !e.parentLogId;
    }).length;
    iterations = Math.max(1, strategistCount);
  }

  // Tools used: count of pill-collapsable rows (log rows whose context.tool is set, or type=tool).
  let toolsUsedCount = 0;
  for (const e of entries) {
    if (e.type === 'tool') {
      toolsUsedCount++;
      continue;
    }
    if (e.type === 'log') {
      const ctx = (e.context ?? {}) as Record<string, unknown>;
      if (typeof ctx['tool'] === 'string' && ctx['tool'].length > 0) toolsUsedCount++;
    }
  }

  // Strategy: prefer the strategist's conversationMetadata.strategy.
  let strategy: AnalysisStrategy = 'legacy';
  const rootStrategist = aiEntries.find(e => {
    const meta = (e.conversationMetadata ?? {}) as Record<string, unknown>;
    return !meta['isSubTask'] && !e.parentLogId;
  }) ?? aiEntries[0];
  if (rootStrategist) {
    const meta = (rootStrategist.conversationMetadata ?? {}) as Record<string, unknown>;
    const s = meta['strategy'];
    if (s === 'flat' || s === 'orchestrated') strategy = s;
  }

  // Fallback to TicketEvent phase.
  if (strategy === 'legacy' && events && events.length > 0) {
    const analysisEvents = events
      .filter(e => e.eventType === 'AI_ANALYSIS')
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    for (const ev of analysisEvents) {
      const meta = (ev.metadata ?? {}) as Record<string, unknown>;
      const phase = meta['phase'];
      if (phase === 'orchestrated_analysis') {
        strategy = 'orchestrated';
        break;
      }
      if (phase === 'deep_analysis') {
        strategy = 'flat';
        break;
      }
    }
  }

  return { strategy, models: Array.from(modelSet), iterations, toolsUsedCount };
}

/** Compose the header strip text for the Analysis Trace / Raw Logs tabs. */
export function formatStrategyStamp(stamp: AnalysisStrategyStamp): string {
  const models = stamp.models.length > 0 ? stamp.models.join(', ') : '—';
  return `Strategy: ${stamp.strategy} · Models: ${models} · Iterations: ${stamp.iterations} · Tools used: ${stamp.toolsUsedCount}`;
}
