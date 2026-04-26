import { open, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JSONPath } from 'jsonpath-plus';
import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import type { ServerDeps } from '../server.js';

/** Cap response payload to bound prompt size. Same convention as read_tool_result_artifact. */
const MAX_RESPONSE_BYTES = 50 * 1024;

/**
 * Above this artifact file size, refuse to load into memory. query_artifact must
 * parse the entire artifact (JSON.parse / DOMParser / CSV split), so unlike
 * read_tool_result_artifact we cannot stream — we instead bail and tell the agent
 * to page via read_tool_result_artifact. Mirrors STREAM_THRESHOLD_BYTES on the
 * sibling tool so the boundary is consistent.
 */
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

type Format = 'json' | 'xml' | 'csv';

function detectFormat(mimeType: string | null, content: string): Format | null {
  const mt = (mimeType ?? '').toLowerCase();
  if (mt.includes('json')) return 'json';
  if (mt.includes('xml')) return 'xml';
  if (mt.includes('csv')) return 'csv';
  // Fallback to content sniff.
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('<')) return 'xml';
  if (trimmed.includes(',') && !trimmed.startsWith('<') && !trimmed.startsWith('{')) return 'csv';
  return null;
}

/**
 * Truncate `text` to fit MAX_RESPONSE_BYTES *bytes* of UTF-8. The naive
 * `text.slice(0, N)` slices by JS code units, but multi-byte UTF-8 chars
 * can still exceed the byte budget — and slicing mid-character can also
 * produce a U+FFFD replacement (3 bytes) that bumps the encoded length
 * over the limit. Walk the trim boundary back until it fits.
 */
function truncatePayload(text: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= MAX_RESPONSE_BYTES) return { text, truncated: false };
  let end = MAX_RESPONSE_BYTES;
  let slice = buffer.subarray(0, end).toString('utf-8');
  while (end > 0 && Buffer.byteLength(slice, 'utf-8') > MAX_RESPONSE_BYTES) {
    end--;
    slice = buffer.subarray(0, end).toString('utf-8');
  }
  return { text: slice, truncated: true };
}

/** Parse CSV row, respecting double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function registerQueryArtifactTool(server: McpServer, { db, config }: ServerDeps): void {
  server.tool(
    'query_artifact',
    'Run a path query against an artifact and return matching slices. Use to pull surgical pieces of structured data (JSON, XML, CSV) without reading the whole file. JSON: JSONPath ($.x.y or $.items[*].name). XML: XPath (/root/elem). CSV: column name to return that column, or @N for row index N.',
    {
      artifact_id: z.string().uuid().describe('The artifact ID to query'),
      ticketId: z.string().uuid().describe('The active ticket ID (server-injected for auth scope)'),
      path: z.string().describe('JSONPath ($.x.y) for JSON, XPath (/root/elem) for XML, header column name (or @N for row N) for CSV'),
      format: z.enum(['json', 'xml', 'csv']).optional().describe('Override format auto-detection (otherwise inferred from artifact mimeType + content)'),
    },
    async (params) => {
      // Resolve artifact + scope. Use findFirst with ticketId in WHERE so the
      // ticket scope acts as the auth guard — unscoped artifacts cannot be
      // reached by a query that supplies any ticketId, and scoped artifacts
      // for a different ticket return "not found" identically.
      const artifact = await db.artifact.findFirst({
        where: { id: params.artifact_id, ticketId: params.ticketId },
      });
      if (!artifact) {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }], isError: true };
      }

      // Defense-in-depth path validation (matches read_tool_result_artifact).
      const resolvedStorage = resolve(config.ARTIFACT_STORAGE_PATH);
      const absPath = resolve(resolvedStorage, artifact.storagePath);
      const rel = relative(resolvedStorage, absPath);
      if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }], isError: true };
      }

      // Guard against pathological large artifacts. query_artifact must parse
      // the whole file (JSON.parse / DOMParser / CSV split), so we cannot stream
      // here the way read_tool_result_artifact can. Above the threshold, bail
      // and direct the agent to page through it via the streaming sibling tool.
      let fileSize: number;
      try {
        const stats = await stat(absPath);
        fileSize = stats.size;
      } catch {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }], isError: true };
      }
      if (fileSize > MAX_ARTIFACT_BYTES) {
        const sizeMb = (fileSize / 1024 / 1024).toFixed(1);
        const limitMb = (MAX_ARTIFACT_BYTES / 1024 / 1024).toFixed(0);
        return {
          content: [{
            type: 'text',
            text: `ERROR: artifact too large for query_artifact (${sizeMb} MB > ${limitMb} MB threshold). Use platform__read_tool_result_artifact with offset+limit to page through it instead.`,
          }],
          isError: true,
        };
      }

      let content: string;
      try {
        // Bounded positional read — file size is verified <= MAX_ARTIFACT_BYTES above.
        const handle = await open(absPath, 'r');
        try {
          const buf = Buffer.alloc(fileSize);
          if (fileSize > 0) {
            await handle.read(buf, 0, fileSize, 0);
          }
          content = buf.toString('utf-8');
        } finally {
          await handle.close();
        }
      } catch {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }], isError: true };
      }

      const fmt: Format | null = params.format ?? detectFormat(artifact.mimeType, content);
      if (!fmt) {
        return {
          content: [{ type: 'text', text: 'ERROR: could not determine artifact format. Pass `format` explicitly (json|xml|csv).' }],
          isError: true,
        };
      }

      try {
        if (fmt === 'json') {
          let json: unknown;
          try {
            json = JSON.parse(content);
          } catch (err) {
            return {
              content: [{ type: 'text', text: `ERROR: artifact is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
          const matches = JSONPath({ path: params.path, json: json as object });
          const rendered = JSON.stringify(matches, null, 2);
          const { text, truncated } = truncatePayload(rendered);
          const footer = `\n\n[matched ${Array.isArray(matches) ? matches.length : 0} value(s)${truncated ? `; payload truncated to ${MAX_RESPONSE_BYTES} bytes` : ''}]`;
          return { content: [{ type: 'text', text: `${text}${footer}` }] };
        }

        if (fmt === 'xml') {
          let doc: Document;
          try {
            doc = new DOMParser().parseFromString(content, 'application/xml') as unknown as Document;
          } catch (err) {
            return {
              content: [{ type: 'text', text: `ERROR: artifact is not valid XML: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
          // xpath.select returns either a node[] (default) or an Attr[] / string / number / boolean
          // depending on the expression. Coerce to string output.
          let result: unknown;
          try {
            result = xpath.select(params.path, doc as unknown as Node);
          } catch (err) {
            return {
              content: [{ type: 'text', text: `ERROR: invalid XPath expression: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
          let rendered: string;
          let count = 0;
          if (Array.isArray(result)) {
            count = result.length;
            rendered = result
              .map((n) => {
                if (n && typeof n === 'object' && 'toString' in n) return String(n);
                return String(n);
              })
              .join('\n');
          } else {
            count = result === null || result === undefined ? 0 : 1;
            rendered = String(result);
          }
          const { text, truncated } = truncatePayload(rendered);
          const footer = `\n\n[matched ${count} node(s)${truncated ? `; payload truncated to ${MAX_RESPONSE_BYTES} bytes` : ''}]`;
          return { content: [{ type: 'text', text: `${text}${footer}` }] };
        }

        // CSV
        const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
        if (lines.length === 0) {
          return { content: [{ type: 'text', text: 'ERROR: artifact has no rows' }], isError: true };
        }
        const header = parseCsvLine(lines[0]);
        // Row-index path: `@N` returns row N (0-indexed, after header).
        if (params.path.startsWith('@')) {
          const idx = Number.parseInt(params.path.slice(1), 10);
          if (!Number.isFinite(idx) || idx < 0 || idx >= lines.length - 1) {
            return { content: [{ type: 'text', text: `ERROR: row index out of range. CSV has ${lines.length - 1} data rows.` }], isError: true };
          }
          const row = parseCsvLine(lines[idx + 1]);
          const obj: Record<string, string> = {};
          for (let i = 0; i < header.length; i++) obj[header[i]] = row[i] ?? '';
          const rendered = JSON.stringify(obj, null, 2);
          const { text, truncated } = truncatePayload(rendered);
          const footer = `\n\n[returned row ${idx}${truncated ? `; payload truncated to ${MAX_RESPONSE_BYTES} bytes` : ''}]`;
          return { content: [{ type: 'text', text: `${text}${footer}` }] };
        }
        // Column-name path: return all values for that column.
        const colIdx = header.indexOf(params.path);
        if (colIdx < 0) {
          return {
            content: [{ type: 'text', text: `ERROR: column "${params.path}" not found. Available: ${header.join(', ')}` }],
            isError: true,
          };
        }
        const values: string[] = [];
        for (let i = 1; i < lines.length; i++) {
          const row = parseCsvLine(lines[i]);
          values.push(row[colIdx] ?? '');
        }
        const rendered = JSON.stringify(values, null, 2);
        const { text, truncated } = truncatePayload(rendered);
        const footer = `\n\n[returned ${values.length} value(s) from column "${params.path}"${truncated ? `; payload truncated to ${MAX_RESPONSE_BYTES} bytes` : ''}]`;
        return { content: [{ type: 'text', text: `${text}${footer}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `ERROR: query_artifact failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
