import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JSONPath } from 'jsonpath-plus';
import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import type { ServerDeps } from '../server.js';

/** Cap response payload to bound prompt size. Same convention as read_tool_result_artifact. */
const MAX_RESPONSE_BYTES = 50 * 1024;

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

function truncatePayload(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= MAX_RESPONSE_BYTES) {
    return { text, truncated: false };
  }
  // Slice by char count then append marker. Char ≤ byte.
  const slice = text.slice(0, MAX_RESPONSE_BYTES);
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
      path: z.string().describe('JSONPath ($.x.y) for JSON, XPath (/root/elem) for XML, header column name (or @N for row N) for CSV'),
      format: z.enum(['json', 'xml', 'csv']).optional().describe('Override format auto-detection (otherwise inferred from artifact mimeType + content)'),
    },
    async (params) => {
      // Resolve artifact + scope.
      const artifact = await db.artifact.findUnique({ where: { id: params.artifact_id } });
      if (!artifact) {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found' }], isError: true };
      }

      // Defense-in-depth path validation (matches read_tool_result_artifact).
      const resolvedStorage = resolve(config.ARTIFACT_STORAGE_PATH);
      const absPath = resolve(resolvedStorage, artifact.storagePath);
      const rel = relative(resolvedStorage, absPath);
      if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }], isError: true };
      }

      let content: string;
      try {
        const buf = await readFile(absPath);
        content = buf.toString('utf-8');
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
