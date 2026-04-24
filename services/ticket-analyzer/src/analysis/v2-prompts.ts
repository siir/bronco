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
 * Teaches the agent to call `platform__request_tool` when no existing tool fits,
 * when a tool is broken, or when a tool is inadequate — surfacing all three kinds
 * of capability gaps to operators rather than improvising silently.
 */
export const REQUEST_NEW_TOOL_SNIPPET = [
  '',
  '## Requesting New, Broken, or Improved Tools',
  'Use `platform__request_tool` to surface capability gaps. Set `kind` to the right value:',
  '',
  '**kind: \'NEW_TOOL\' (default)** — no existing tool comes close.',
  'Call when you are about to improvise with a generic tool or abandon a line',
  'of investigation because the right tool does not exist.',
  'Example:',
  '  platform__request_tool({',
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
  '  platform__request_tool({',
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
  '  platform__request_tool({',
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
 * System-prompt snippet teaching the agent how to recognize and react to
 * structured MCP tool errors. Pairs with buildMcpToolErrorResult() in
 * analysis/shared.ts — failed tool calls return a JSON envelope with
 * `_mcp_tool_error: true`, plus `errorClass`, `retryable`, and `guidance`.
 */
export const TOOL_ERROR_SYSTEM_PROMPT_SNIPPET = [
  '',
  '## Handling Tool Failures',
  '',
  'Some tool calls fail. A failed tool_result is a JSON object starting with',
  '`{"_mcp_tool_error": true, ...}`. When you see this, do NOT treat the message',
  'as data — it is a failure signal.',
  '',
  'Inspect these fields and react:',
  '- `errorClass` — kind of failure (transport / auth / tool_not_registered /',
  '  tool_logic / timeout / rate_limit / repeated_failure / unknown)',
  '- `retryable` — boolean. If `false`, do NOT call the same tool with the same',
  '  inputs again in this run. It will be short-circuited.',
  '- `guidance` — human-readable next step tailored to the error class.',
  '',
  'Rules:',
  '- If `retryable: true` (e.g. timeout, rate_limit), retry at most ONCE, with',
  '  the same inputs.',
  '- If `retryable: false`, switch approach: try a different tool, change inputs,',
  '  or abandon this line of investigation and note the gap in your analysis.',
  '- If multiple tools in the same class fail (e.g. every repo tool returns',
  '  `transport` errors), suspect infrastructure. Stop calling that class and',
  '  flag the outage via `platform__request_tool` with `kind: "BROKEN_TOOL"`.',
  '- After 2 failures of the same `(tool, input)` pair, the runner blocks further',
  '  attempts automatically — you will get `errorClass: "repeated_failure"`.',
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

/**
 * Teaches the agent to pair every run_custom_query call with a
 * platform__request_tool call naming the specialized tool that would have
 * answered the same question.
 * Makes run_custom_query usage an explicit product roadmap signal for the
 * autonomousDBA tool catalog. Also encourages schema/system verification before
 * querying to reduce hallucinated schema names (e.g. DBADashboard, MDW).
 *
 * Requires platform__request_tool to be registered in the agent's tool catalog
 * (see issue #386). Dedup within a run is encouraged to avoid burning the
 * tool-request rate limit on near-duplicate requests.
 */
export const AD_HOC_QUERY_PAIRING_SNIPPET = [
  '',
  '## Ad-hoc Query Pairing Rule (autonomousDBA Roadmap Signal)',
  '`run_custom_query` is an escape hatch — every call must be paired with a',
  '`platform__request_tool` call describing the specialized tool that would have',
  'answered the same question.',
  '',
  'When you call `run_custom_query`:',
  '1. Also call `platform__request_tool` with `kind: \'NEW_TOOL\'` (if no existing',
  '   tool comes close) or `kind: \'IMPROVE_TOOL\'` (if an existing tool came close',
  '   but lacked the output you needed). Required fields: `requestedName`,',
  '   `displayTitle`, `description`, and `rationale` — all are mandatory.',
  '2. Use a **stable, semantic name** for `requestedName` — e.g.',
  '   `get_deadlock_graph_xml`, `list_recent_rcsi_changes`. Do NOT use ad-hoc names',
  '   like `query_1` or `deadlock_lookup`. Stable names let repeated encounters',
  '   across runs dedup into one enriched request row.',
  '3. In the rationale, paste the T-SQL you wrote and describe the semantic question',
  '   you were answering. The product team uses this to design the eventual',
  '   first-class tool.',
  '4. **Dedup within the run** — if you are calling `run_custom_query` multiple',
  '   times for the same semantic question with different WHERE clauses or',
  '   parameters, ONE `platform__request_tool` call covers the class. Do not burn',
  '   the rate limit on near-duplicates.',
  '',
  'Verify system/schema assumptions before querying: confirm the target system from',
  'the ticket context, prior tool outputs, or the currently available tool list',
  'before proceeding. If querying a monitoring/DBA schema (e.g.',
  '`DBADashboard`, `MDW`, `dbatools`), verify the schema/table exists via',
  '`sys.tables` or equivalent before issuing the full query. Do not assume schemas',
  'from general SQL Server knowledge — many environments do not have them.',
  '',
  'Prefer purpose-built specialized tools over ad-hoc queries — only use',
  '`run_custom_query` when no specialized tool applies.',
].join('\n');

/**
 * Anti-stall snippet appended to the orchestrated-v2 strategist system prompt.
 * The observed failure mode (issue #366) is the orchestrator repeatedly asking
 * to re-read the KD without dispatching a sub-task or writing any section, so
 * we require every non-terminal turn to produce concrete forward progress.
 * This is advisory only — the runtime stall detector in orchestrated-v2.ts is
 * the hard guard.
 */
export const NO_STALL_SYSTEM_PROMPT_SNIPPET = [
  '',
  '## Forward Progress Required',
  'Every non-terminal iteration MUST produce concrete forward progress: either dispatch',
  'at least one sub-task in `tasks`, or set `done: true` with a `finalAnalysis`. Do not',
  'return a plan that is only "I need to review the knowledge document" — if you need to',
  'check what has been recorded, dispatch a sub-task that calls `platform__kd_read_toc`',
  'and/or `platform__kd_read_section` and uses the result to decide the next investigation',
  'step. Repeated empty `tasks` arrays across consecutive turns will trip the stall',
  'detector and the orchestrator will terminate early.',
].join('\n');
