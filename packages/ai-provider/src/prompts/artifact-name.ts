import type { PromptDefinition } from './types.js';

export const ARTIFACT_NAME_SYSTEM: PromptDefinition = {
  key: 'artifact.name.system',
  name: 'Artifact Name Generator',
  description:
    'Generates a short human-friendly displayName and one-to-two-sentence description for a system-generated artifact (probe result or MCP tool output) based on its raw content.',
  taskType: 'GENERATE_ARTIFACT_NAME',
  role: 'SYSTEM',
  content:
    'You generate short, human-friendly names and descriptions for system-generated ' +
    'artifact files (probe results, MCP tool outputs) based on a small content preview.\n\n' +
    'Output STRICT JSON ONLY — no prose, no code fences, no commentary:\n' +
    '{"displayName":"<3-8 word title>","description":"<1-2 sentence summary>"}\n\n' +
    'Rules:\n' +
    '- displayName: 3-8 words. Bias toward verbs + specific nouns (e.g. ' +
    '"Top blocking sessions snapshot", "Index fragmentation scan", "Failed login audit").\n' +
    '- Avoid generic words like "result", "output", "data", "file", "artifact".\n' +
    '- description: 1-2 sentences. Describe what the artifact contains and why it matters.\n' +
    '- If content is empty, malformed, or unparseable, still return JSON with a best-effort title ' +
    'derived from the tool name supplied in the prompt.\n' +
    '- Never include markdown, backticks, or surrounding text — JSON only.',
  temperature: 0.2,
  maxTokens: 200,
};

export const ARTIFACT_NAME_PROMPTS: PromptDefinition[] = [ARTIFACT_NAME_SYSTEM];
