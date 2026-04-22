/**
 * v2-only system-prompt snippets. These are appended to agent system prompts
 * for v2 strategies (flat-v2 and orchestrated-v2) to enable kd_* knowledge-doc
 * writes, tool-result truncation awareness, and tool-request nudging.
 *
 * v1 strategies MUST NOT import from this file — v1 prompts are frozen at the
 * pre-#300 snapshot (no kd_* awareness, no truncation notes).
 */

/**
 * System-prompt snippet advising the agent on how to recognize and paginate
 * truncated tool results. Appended to v2 agent system prompts so the agent
 * knows to call `platform__read_tool_result_artifact` when a preview is
 * insufficient.
 */
export const TRUNCATION_SYSTEM_PROMPT_SNIPPET = [
  '',
  'Some tool results may be truncated to control token usage. Truncated results',
  'include a header line "[truncated — full output saved as artifact]" followed',
  'by an `artifactId:` value. If the truncated preview is insufficient for your',
  'analysis, call `platform__read_tool_result_artifact(artifactId, ...)` to fetch',
  'more — supply `offset` + `limit` to page through, or `grep` to search for',
  'specific patterns.',
].join('\n');

/**
 * Nudges the agent to scan the available tool list before falling back to
 * generic tools like `run_custom_query`. Pairs with REQUEST_NEW_TOOL_SNIPPET
 * so gaps get surfaced as tool requests rather than silently improvised.
 */
export const PREFER_EXISTING_TOOLS_SNIPPET = [
  '',
  '## Using Tools Effectively',
  'Before working around a missing capability, scan the available tools. Use',
  'specific tools when they fit; only fall back to generic tools like',
  '`run_custom_query` when no specific tool applies to your question.',
].join('\n');

/**
 * Teaches the agent to call `request_tool` when no existing tool fits —
 * surfacing capability gaps to operators rather than improvising silently.
 */
export const REQUEST_NEW_TOOL_SNIPPET = [
  '',
  '## Requesting New Tools',
  'If no existing tool fits the job and you are about to improvise with a',
  'generic tool or give up on a line of investigation, call `request_tool`',
  'with a specific name, description, suggested inputs, and why it was',
  'needed for this ticket.',
  '',
  'Good examples of when to call:',
  '- You inspected a stored procedure definition via `run_custom_query` that',
  '  a `describe_schema_object` tool would serve better',
  '- You parsed an execution plan XML by hand because there is no',
  '  `analyze_execution_plan` tool',
  '- You re-queried deadlock history because there is no',
  '  `get_deadlock_history` tool returning structured results',
  '',
  'Do not request vague capabilities like "a better tool" or "an easier way."',
  'Each request should be specific enough that someone could implement it.',
].join('\n');

/**
 * System-prompt snippet appended to v2 agentic system prompts. Agent adoption
 * is opt-out — findings must flow through the `kd_*` tools so the knowledge
 * doc stays the authoritative source. At end-of-run a fallback pass fills any
 * required section the agent didn't populate.
 */
export const KD_SYSTEM_PROMPT_SNIPPET = [
  '',
  '## Knowledge Document (kd_* tools)',
  '',
  'Your investigative findings must be recorded via the kd_* tools, not free-form text in your response.',
  '',
  'Required sections in the knowledge document for this ticket:',
  '- platform__kd_update_section(sectionKey=\'problemStatement\', ...) — your understanding of the ticket',
  '- platform__kd_update_section(sectionKey=\'environment\', ...) — relevant systems, databases, repos',
  '- platform__kd_update_section(sectionKey=\'rootCause\', ...) — once identified',
  '- platform__kd_update_section(sectionKey=\'recommendedFix\', ...) — once determined',
  '- platform__kd_update_section(sectionKey=\'risks\', ...) — what could go wrong',
  '',
  'For growing evidence, hypotheses, and open questions, use:',
  '- platform__kd_add_subsection(parentSectionKey=\'evidence\', title, content)',
  '- platform__kd_add_subsection(parentSectionKey=\'hypotheses\', title, content)',
  '- platform__kd_add_subsection(parentSectionKey=\'openQuestions\', title, content)',
  '',
  'Before making progress, call platform__kd_read_toc to see what\'s already documented.',
  'Call platform__kd_read_section on relevant sections to avoid re-discovering facts.',
  '',
  'Your final analysis text (in the response) should be a concise executive summary — the detail lives in the knowledge doc. The AI_ANALYSIS composer will pull Root Cause + Recommended Fix + Risks from the doc to render the analysis view.',
].join('\n');
