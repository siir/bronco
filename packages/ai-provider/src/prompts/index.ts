export type { PromptDefinition } from './types.js';

export { IMAP_PROMPTS } from './imap.js';
export * from './imap.js';

export { DEVOPS_PROMPTS } from './devops.js';
export * from './devops.js';

export { RESOLVER_PROMPTS } from './resolver.js';
export * from './resolver.js';

export { LOG_PROMPTS } from './logs.js';
export * from './logs.js';

export { SYSTEM_ANALYSIS_PROMPTS } from './system-analysis.js';
export * from './system-analysis.js';

export { RELEASE_NOTES_PROMPTS } from './release-notes.js';
export * from './release-notes.js';

export { ROUTING_PROMPTS } from './routing.js';
export * from './routing.js';

export { CLIENT_MEMORY_PROMPTS } from './client-memory.js';
export * from './client-memory.js';

export { DETECT_TOOL_GAPS_PROMPTS } from './detect-tool-gaps.js';
export * from './detect-tool-gaps.js';

export { ANALYZE_TOOL_REQUESTS_PROMPTS } from './analyze-tool-requests.js';
export * from './analyze-tool-requests.js';

export { CHAT_PROMPTS } from './chat-classify-reply.js';
export * from './chat-classify-reply.js';

// Re-export individual prompts for direct import convenience
import { IMAP_PROMPTS } from './imap.js';
import { DEVOPS_PROMPTS } from './devops.js';
import { RESOLVER_PROMPTS } from './resolver.js';
import { LOG_PROMPTS } from './logs.js';
import { SYSTEM_ANALYSIS_PROMPTS } from './system-analysis.js';
import { RELEASE_NOTES_PROMPTS } from './release-notes.js';
import { ROUTING_PROMPTS } from './routing.js';
import { CLIENT_MEMORY_PROMPTS } from './client-memory.js';
import { DETECT_TOOL_GAPS_PROMPTS } from './detect-tool-gaps.js';
import { ANALYZE_TOOL_REQUESTS_PROMPTS } from './analyze-tool-requests.js';
import { CHAT_PROMPTS } from './chat-classify-reply.js';
import type { PromptDefinition } from './types.js';

/**
 * Complete registry of all hardcoded prompt definitions.
 *
 * Used by:
 * - The control panel to list available prompts and their descriptions
 * - The seed script to populate the prompt registry
 * - The prompt resolver to look up base prompt content by key
 */
export const ALL_PROMPTS: PromptDefinition[] = [
  ...IMAP_PROMPTS,
  ...DEVOPS_PROMPTS,
  ...RESOLVER_PROMPTS,
  ...LOG_PROMPTS,
  ...SYSTEM_ANALYSIS_PROMPTS,
  ...RELEASE_NOTES_PROMPTS,
  ...ROUTING_PROMPTS,
  ...CLIENT_MEMORY_PROMPTS,
  ...DETECT_TOOL_GAPS_PROMPTS,
  ...ANALYZE_TOOL_REQUESTS_PROMPTS,
  ...CHAT_PROMPTS,
];

/**
 * Lookup a prompt definition by its key.
 * Returns undefined if the key doesn't match any registered prompt.
 */
const promptMap = new Map<string, PromptDefinition>();
for (const p of ALL_PROMPTS) {
  promptMap.set(p.key, p);
}

export function getPromptByKey(key: string): PromptDefinition | undefined {
  return promptMap.get(key);
}
