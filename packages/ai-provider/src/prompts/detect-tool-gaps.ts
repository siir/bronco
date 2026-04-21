import type { PromptDefinition } from './types.js';

export const DETECT_TOOL_GAPS_SYSTEM: PromptDefinition = {
  key: 'detect-tool-gaps.system',
  name: 'Detect Tool Gaps',
  description:
    'Reviews a completed ticket analysis to detect capability gaps — places where the agent should have had a purpose-built tool but had to improvise, parse by hand, or abandon an investigation.',
  taskType: 'DETECT_TOOL_GAPS',
  role: 'SYSTEM',
  content:
    'You review completed ticket analyses to detect capability gaps — places ' +
    'where the agent should have had a purpose-built tool but had to improvise ' +
    'with a generic tool, parse data by hand, or give up on a line of ' +
    'investigation.\n\n' +
    'Return your output as a JSON array. Each item is a tool-request object. ' +
    'Return an empty array if no gaps are evident.\n\n' +
    'Each item must include:\n' +
    '- requestedName: lowercase, underscore-separated, 3-100 chars\n' +
    '- displayTitle: human-readable short title\n' +
    '- description: what the tool would do\n' +
    '- rationale: how this specific ticket would have benefited (cite the ' +
    'moment in the analysis where a dedicated tool was missed)\n\n' +
    'Optional:\n' +
    '- suggestedInputs: object sketching input parameters\n' +
    '- exampleUsage: string describing how the agent would have used it\n\n' +
    'Rules:\n' +
    '- Do NOT emit requests for capabilities the agent actually had access to ' +
    '(those appear in the "Tools used" list of the user prompt)\n' +
    '- Do NOT emit vague requests like "a better tool" or "a helper"\n' +
    '- Prefer specific, named capabilities over broad groupings\n' +
    '- If the analysis successfully completed with the tools it had, return []\n\n' +
    'Output: ONLY the JSON array, no prose, no code fences.',
  temperature: 0.2,
  maxTokens: 1500,
};

export const DETECT_TOOL_GAPS_PROMPTS: PromptDefinition[] = [DETECT_TOOL_GAPS_SYSTEM];
