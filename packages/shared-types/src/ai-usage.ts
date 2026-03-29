import type { EntityType } from './log.js';

// --- AI Usage Log (tracks every AI generation call) ---

export interface AiUsageLogRecord {
  id: string;
  provider: string;
  model: string;
  taskType: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  costUsd: number | null;
  entityId: string | null;
  entityType: EntityType | null;
  clientId: string | null;
  promptKey: string | null;
  createdAt: Date;
}

export interface AiUsageLogDetail extends AiUsageLogRecord {
  promptText: string | null;
  responseText: string | null;
  ticketSubject: string | null;
}

// --- AI Model Cost (per-model pricing) ---

export interface AiModelCostRecord {
  id: string;
  provider: string;
  model: string;
  displayName: string | null;
  inputCostPer1m: number;
  outputCostPer1m: number;
  isActive: boolean;
  updatedAt: Date;
  createdAt: Date;
}

// --- Aggregated usage stats ---

export interface AiUsageSummary {
  provider: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  callCount: number;
}

export interface EntityCostSummary {
  entityId: string;
  entityType: EntityType | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  callCount: number;
}
