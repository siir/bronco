// --- AI Prompt Override Management (editable from control panel) ---

export const OverrideScope = {
  APP_WIDE: 'APP_WIDE',
  CLIENT: 'CLIENT',
} as const;
export type OverrideScope = (typeof OverrideScope)[keyof typeof OverrideScope];

export const OverridePosition = {
  PREPEND: 'PREPEND',
  APPEND: 'APPEND',
} as const;
export type OverridePosition = (typeof OverridePosition)[keyof typeof OverridePosition];

export const KeywordCategory = {
  TICKET: 'TICKET',
  EMAIL: 'EMAIL',
  DEVOPS: 'DEVOPS',
  CODE: 'CODE',
  DATABASE: 'DATABASE',
  GENERAL: 'GENERAL',
} as const;
export type KeywordCategory = (typeof KeywordCategory)[keyof typeof KeywordCategory];

export interface PromptOverrideRecord {
  id: string;
  promptKey: string;
  scope: OverrideScope;
  clientId: string | null;
  position: OverridePosition;
  content: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromptKeywordRecord {
  id: string;
  token: string;
  label: string;
  description: string;
  sampleValue: string | null;
  category: KeywordCategory;
  createdAt: Date;
  updatedAt: Date;
}
