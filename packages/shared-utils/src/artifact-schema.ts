/**
 * Artifact schema inference.
 *
 * Lightweight, best-effort schema/shape inference from an artifact's head + tail bytes.
 * Used to render the structured `## Attachments` block in the agentic prompt without
 * inlining content. The agent can then decide whether to call
 * `platform__read_tool_result_artifact` (full body) or `platform__query_artifact`
 * (surgical slice) to dig.
 *
 * Two tiers:
 *   1. `mcp_provided` — the producing MCP tool emitted a top-level `_schema` field
 *      in its envelope. This is the canonical contract; adopt as-is.
 *   2. `head_tail_infer` — best-effort inference from the artifact's leading + trailing
 *      bytes. Always partial; never fail (caller logs WARN and falls through).
 *
 * No external deps — all parsing is hand-rolled and bounded.
 */

export interface InferredSchema {
  kind: 'json_object' | 'json_array' | 'xml' | 'csv' | 'text' | 'unknown';
  // For json_array
  itemCount?: number;
  itemSchema?: Record<string, string>; // keys → coarse type names
  // For json_object
  topLevelKeys?: Record<string, string>;
  // For xml
  rootElement?: string;
  firstChildren?: string[];
  // For csv
  columns?: string[];
  rowCount?: number;
  // For text
  lineCount?: number;
  byteCount?: number;
  // Caveats
  partial?: boolean; // schema may be incomplete (truncated input, polymorphic items)
  inferenceSource: 'mcp_provided' | 'head_tail_infer' | 'unknown';
}

/** Coarse type name for a JS value. */
function jsTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number') return Number.isInteger(v as number) ? 'int' : 'float';
  return t;
}

/** Try to parse JSON; if it fails, attempt a "trim trailing junk" recovery. */
function tryParseJson(text: string): { value: unknown; partial: boolean } | null {
  try {
    return { value: JSON.parse(text), partial: false };
  } catch {
    // Recovery 1: cut to last `}` (object) or `]` (array)
    const lastBrace = text.lastIndexOf('}');
    const lastBracket = text.lastIndexOf(']');
    const cut = Math.max(lastBrace, lastBracket);
    if (cut > 0) {
      try {
        return { value: JSON.parse(text.slice(0, cut + 1)), partial: true };
      } catch {
        // fall through
      }
    }
    return null;
  }
}

/** Extract top-level keys → type names from a parsed object. */
function objectKeysToTypes(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = jsTypeName(v);
  }
  return out;
}

/** Find the first `{...}` balanced object substring in text. */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Count top-level commas in a text fragment of a JSON array (best-effort). */
function countTopLevelArrayItems(text: string): number | undefined {
  // Find first `[` and last `]`.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return undefined;
  const body = text.slice(start + 1, end);
  let depth = 0;
  let inStr = false;
  let escape = false;
  let commas = 0;
  let nonWs = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      nonWs = true;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      commas++;
      continue;
    }
    if (!/\s/.test(ch)) nonWs = true;
  }
  if (!nonWs) return 0;
  return commas + 1;
}

/** Adopt a top-level `_schema` field from an MCP tool envelope (tier 1). */
export function adoptMcpSchema(mcpSchema: unknown): InferredSchema {
  if (!mcpSchema || typeof mcpSchema !== 'object') {
    return { kind: 'unknown', inferenceSource: 'unknown' };
  }
  const s = mcpSchema as Record<string, unknown>;
  // Trust the producer; coerce shape if recognizable, else passthrough as object.
  const kind = typeof s.kind === 'string' ? (s.kind as InferredSchema['kind']) : 'unknown';
  return {
    ...(s as Partial<InferredSchema>),
    kind,
    inferenceSource: 'mcp_provided',
  };
}

/**
 * Infer a lightweight schema from the head + tail of an artifact.
 * Never throws — returns `{ kind: 'unknown', inferenceSource: 'unknown' }`
 * if nothing matches.
 */
export function inferSchemaFromHeadTail(
  head: string,
  tail: string,
  mimeType: string | null
): InferredSchema {
  const trimmedHead = head.trimStart();
  const combined = head + tail;
  const mt = (mimeType ?? '').toLowerCase();

  // ---- JSON detection ----
  if (trimmedHead.startsWith('{') || mt.includes('json') && trimmedHead.startsWith('{')) {
    // Object
    const parsed = tryParseJson(combined) ?? tryParseJson(trimmedHead);
    if (parsed && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
      return {
        kind: 'json_object',
        topLevelKeys: objectKeysToTypes(parsed.value as Record<string, unknown>),
        partial: parsed.partial,
        inferenceSource: 'head_tail_infer',
      };
    }
    // Got `{` but couldn't parse — return partial with no keys.
    return { kind: 'json_object', partial: true, inferenceSource: 'head_tail_infer' };
  }

  if (trimmedHead.startsWith('[')) {
    // Array
    const parsed = tryParseJson(combined);
    if (parsed && Array.isArray(parsed.value)) {
      const arr = parsed.value as unknown[];
      const first = arr.find((x) => x && typeof x === 'object' && !Array.isArray(x)) as
        | Record<string, unknown>
        | undefined;
      const itemSchema = first ? objectKeysToTypes(first) : undefined;
      return {
        kind: 'json_array',
        itemCount: arr.length,
        itemSchema,
        partial: parsed.partial,
        inferenceSource: 'head_tail_infer',
      };
    }
    // Couldn't parse the whole thing — try first object from head, count items via tail.
    const firstObj = extractFirstObject(trimmedHead);
    let itemSchema: Record<string, string> | undefined;
    if (firstObj) {
      try {
        const obj = JSON.parse(firstObj) as Record<string, unknown>;
        itemSchema = objectKeysToTypes(obj);
      } catch {
        // ignore
      }
    }
    const itemCount = countTopLevelArrayItems(combined);
    return {
      kind: 'json_array',
      itemSchema,
      itemCount,
      partial: true,
      inferenceSource: 'head_tail_infer',
    };
  }

  // ---- XML detection ----
  if (trimmedHead.startsWith('<?xml') || trimmedHead.startsWith('<') && /^<[a-zA-Z]/.test(trimmedHead)) {
    // Skip XML preamble if any.
    let body = trimmedHead;
    const preambleEnd = body.indexOf('?>');
    if (body.startsWith('<?xml') && preambleEnd > 0) {
      body = body.slice(preambleEnd + 2).trimStart();
    }
    // First element name.
    const rootMatch = /^<([a-zA-Z_][\w:-]*)/.exec(body);
    if (rootMatch) {
      const rootElement = rootMatch[1];
      // Find first 3-5 distinct child element names by scanning for `<name` after rootMatch.
      const childRegex = /<([a-zA-Z_][\w:-]*)/g;
      childRegex.lastIndex = rootMatch[0].length;
      const seen = new Set<string>();
      const firstChildren: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = childRegex.exec(body)) !== null && firstChildren.length < 5) {
        const name = m[1];
        if (name === rootElement) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        firstChildren.push(name);
      }
      return {
        kind: 'xml',
        rootElement,
        firstChildren: firstChildren.length > 0 ? firstChildren : undefined,
        partial: true,
        inferenceSource: 'head_tail_infer',
      };
    }
  }

  // ---- CSV detection ----
  // Heuristic: first line has commas, no leading `<` or `{`, and most lines look comma-separated.
  const firstNewline = head.indexOf('\n');
  if (firstNewline > 0) {
    const firstLine = head.slice(0, firstNewline).trim();
    if (firstLine.length > 0 && firstLine.includes(',') && !firstLine.startsWith('<') && !firstLine.startsWith('{')) {
      // Simple split — doesn't handle quoted commas, but good enough for a preview.
      const columns = firstLine.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      // rowCount: count newlines across head + tail; mark partial.
      const headLines = head.split('\n').length - 1;
      const tailLines = tail.split('\n').length - 1;
      return {
        kind: 'csv',
        columns,
        rowCount: headLines + tailLines, // approximate
        partial: true,
        inferenceSource: 'head_tail_infer',
      };
    }
  }

  // ---- Text fallback ----
  const lineCount = head.split('\n').length + tail.split('\n').length;
  const byteCount = head.length + tail.length;
  return {
    kind: 'text',
    lineCount,
    byteCount,
    partial: true,
    inferenceSource: 'head_tail_infer',
  };
}

/**
 * Render an InferredSchema as a short human-readable string for the agentic prompt.
 * Targets ~1 line; agent reads this to decide whether to fetch full content.
 */
export function formatSchemaForPrompt(schema: InferredSchema): string {
  if (!schema) return '';
  const partialMark = schema.partial ? ' (partial)' : '';
  switch (schema.kind) {
    case 'json_object': {
      if (!schema.topLevelKeys || Object.keys(schema.topLevelKeys).length === 0) {
        return `JSON object${partialMark}`;
      }
      const keys = Object.entries(schema.topLevelKeys)
        .map(([k, t]) => `${k} (${t})`)
        .join(', ');
      return `JSON object: ${keys}${partialMark}`;
    }
    case 'json_array': {
      const count = schema.itemCount != null ? `${schema.itemCount} items` : '? items';
      if (!schema.itemSchema || Object.keys(schema.itemSchema).length === 0) {
        return `JSON array [${count}]${partialMark}`;
      }
      const itemKeys = Object.entries(schema.itemSchema)
        .map(([k, t]) => `${k} (${t})`)
        .join(', ');
      return `JSON array [${count}]; each: ${itemKeys}${partialMark}`;
    }
    case 'xml': {
      const root = schema.rootElement ?? '?';
      const children = schema.firstChildren && schema.firstChildren.length > 0
        ? `; children: ${schema.firstChildren.join(', ')}`
        : '';
      return `XML <${root}>${children}${partialMark}`;
    }
    case 'csv': {
      const cols = schema.columns ? schema.columns.join(', ') : '?';
      const rows = schema.rowCount != null ? `${schema.rowCount} rows` : '? rows';
      return `CSV (${rows}): ${cols}${partialMark}`;
    }
    case 'text': {
      const lc = schema.lineCount != null ? `${schema.lineCount} lines` : '?';
      const bc = schema.byteCount != null ? `${schema.byteCount} bytes` : '?';
      return `Text (~${lc}, ~${bc})`;
    }
    default:
      return 'unknown';
  }
}
