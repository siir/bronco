import type { TicketCategory } from './ticket.js';

// --- Memory Type (what kind of knowledge this entry represents) ---

export const MemoryType = {
  /** General client knowledge — environment, databases, architecture */
  CONTEXT: 'CONTEXT',
  /** Step-by-step procedures for specific scenarios */
  PLAYBOOK: 'PLAYBOOK',
  /** Which tools/resources to use and how */
  TOOL_GUIDANCE: 'TOOL_GUIDANCE',
} as const;
export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

// --- Memory Source (how this entry was created) ---

export const MemorySource = {
  /** Created manually by the operator */
  MANUAL: 'MANUAL',
  /** Extracted/learned by AI from resolved tickets */
  AI_LEARNED: 'AI_LEARNED',
} as const;
export type MemorySource = (typeof MemorySource)[keyof typeof MemorySource];

// --- Client Memory (per-client operational knowledge) ---

export interface ClientMemory {
  id: string;
  clientId: string;
  title: string;
  memoryType: MemoryType;
  /** When set, this memory only applies to tickets with this category. Null = all categories. */
  category: TicketCategory | null;
  /** Free-form tags for flexible matching (e.g. "blocking", "deadlocks", "azure-sql"). */
  tags: string[];
  /** Markdown content — the actual knowledge to inject into AI context. */
  content: string;
  isActive: boolean;
  sortOrder: number;
  source: MemorySource;
  createdAt: Date;
  updatedAt: Date;
}
