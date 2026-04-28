/**
 * Strips NUL bytes (0x00) from a string. Postgres TEXT columns reject any
 * value containing NUL with error 22021 ("invalid byte sequence for encoding
 * 'UTF8': 0x00"). This scrubber sits at every persistence chokepoint where
 * agent-supplied content (tool results, system prompts, response text) is
 * about to land in the audit log or prompt archive — see issue #473.
 *
 * The scrub is defense-in-depth: if upstream content is ever NUL-clean, this
 * is a no-op (cheap path skips the regex). When NULs do appear, they are
 * removed silently — the alternative is the entire row being dropped on
 * insert, which corrupts cost tracking and the analysis trace UI.
 *
 * Pass-through for `null` / `undefined` so call sites can wrap nullable fields
 * without nullish-checks scattered through the writer.
 *
 * Likely upstream sources of NUL bytes (not addressed by this scrub — file
 * follow-up issues if found):
 *   - `read_file` against UTF-16 LE encoded source files (Windows-default
 *     SQL files have interspersed 0x00 bytes that survive a naive UTF-8 read).
 *   - Binary content read via `read_tool_result_artifact` and serialized into
 *     the conversation message stream.
 */
const NUL = String.fromCharCode(0);
const NUL_PATTERN = new RegExp(NUL, 'g');

export function stripNulBytes<T extends string | null | undefined>(value: T): T {
  if (value == null) return value;
  if (!value.includes(NUL)) return value;
  return value.replace(NUL_PATTERN, '') as T;
}
