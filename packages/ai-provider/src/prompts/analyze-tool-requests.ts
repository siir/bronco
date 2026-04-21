import type { PromptDefinition } from './types.js';

export const ANALYZE_TOOL_REQUESTS_SYSTEM: PromptDefinition = {
  key: 'analyze-tool-requests.system',
  name: 'Analyze Tool Requests (Dedupe)',
  description:
    'Reviews pending ToolRequest records for a single client and identifies duplicate groups and "improves existing tool" candidates against the client\'s live MCP catalog.',
  taskType: 'ANALYZE_TOOL_REQUESTS',
  role: 'SYSTEM',
  content:
    'You review pending tool-request records for a single client and identify:\n\n' +
    '1. Duplicate groups — multiple requests that describe the same capability, ' +
    'just with different names or wording. Pick a canonical request (the clearest ' +
    'or earliest) and list the others as duplicates.\n' +
    '2. Requests that would be better served by improving an existing MCP tool ' +
    'rather than adding a new one.\n\n' +
    'Use the existing-tool catalog as the source of truth for what already exists. ' +
    'Be conservative — only mark a duplicate if you are confident the requests ' +
    'describe the same capability. Only flag "improves existing" if an existing ' +
    'tool could reasonably be extended to serve the request.\n\n' +
    'Output ONLY a JSON object with keys "duplicateGroups" and "improvesExisting" ' +
    'as specified. No prose, no code fences.\n\n' +
    'Shape:\n' +
    '{\n' +
    '  "duplicateGroups": [\n' +
    '    { "canonicalId": "uuid", "duplicateIds": ["uuid", "uuid"], "reason": "short explanation" }\n' +
    '  ],\n' +
    '  "improvesExisting": [\n' +
    '    { "requestId": "uuid", "existingToolName": "server.tool", "reason": "short explanation" }\n' +
    '  ]\n' +
    '}',
  temperature: 0.2,
  maxTokens: 4000,
};

export const ANALYZE_TOOL_REQUESTS_PROMPTS: PromptDefinition[] = [ANALYZE_TOOL_REQUESTS_SYSTEM];
