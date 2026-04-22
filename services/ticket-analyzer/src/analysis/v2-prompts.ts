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
 * Teaches the agent to call `request_tool` when no existing tool fits, when
 * a tool is broken, or when a tool is inadequate — surfacing all three kinds
 * of capability gaps to operators rather than improvising silently.
 */
export const REQUEST_NEW_TOOL_SNIPPET = [
  '',
  '## Requesting New, Broken, or Improved Tools',
  'Use `request_tool` to surface capability gaps. Set `kind` to the right value:',
  '',
  '**kind: \'NEW_TOOL\' (default)** — no existing tool comes close.',
  'Call when you are about to improvise with a generic tool or abandon a line',
  'of investigation because the right tool does not exist.',
  'Example:',
  '  request_tool({',
  '    kind: \'NEW_TOOL\',',
  '    requestedName: \'analyze_execution_plan\',',
  '    displayTitle: \'Analyze SQL Execution Plan XML\',',
  '    description: \'Parse and summarize a SQL Server XML execution plan, surfacing costly operators, missing index hints, and parallelism warnings.\',',
  '    rationale: \'Had to parse the plan XML by hand via run_custom_query — a dedicated tool would return structured operator costs.\',',
  '  })',
  '',
  '**kind: \'BROKEN_TOOL\'** — an existing tool is malfunctioning.',
  'Call when a tool you tried returns errors, times out, or returns malformed',
  'output repeatedly across this analysis. Use the exact tool name.',
  'Example:',
  '  request_tool({',
  '    kind: \'BROKEN_TOOL\',',
  '    requestedName: \'search_code\',',
  '    displayTitle: \'search_code failing with SSH not found\',',
  '    description: \'Every call to search_code fails with "ssh: not found". The mcp-repo server appears to be missing the SSH binary in its container.\',',
  '    rationale: \'Attempted search_code three times during this analysis — all calls returned the same SSH error, blocking code exploration.\',',
  '  })',
  '',
  '**kind: \'IMPROVE_TOOL\'** — an existing tool works but is inadequate.',
  'Call when a tool returns something useful but is missing a needed field,',
  'has a confusing interface, or returns too little data to be actionable.',
  'Use the exact tool name.',
  'Example:',
  '  request_tool({',
  '    kind: \'IMPROVE_TOOL\',',
  '    requestedName: \'get_blocking_tree\',',
  '    displayTitle: \'get_blocking_tree: add query text to output\',',
  '    description: \'The tool returns session IDs and wait types but omits the blocking query text, requiring a follow-up run_custom_query to fetch it.\',',
  '    rationale: \'Had to make a second query to retrieve the blocking SQL text — including it in the blocking tree output would save the extra round-trip.\',',
  '  })',
  '',
  'Do not call for vague issues. Each request must be specific enough that',
  'an operator can act on it without guessing.',
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
