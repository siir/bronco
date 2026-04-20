import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerArtifactTools(server: McpServer, { db, config }: ServerDeps): void {
  server.tool(
    'read_tool_result_artifact',
    'Read a truncated tool-result artifact referenced by artifactId. Use when a prior tool result was truncated and you need to inspect more of it. Supports paging (offset + limit) and grep (regex search).',
    {
      artifactId: z.string().uuid().describe('The artifact ID from a prior truncated tool result'),
      ticketId: z.string().uuid().describe('The active ticket ID (server-injected for auth scope)'),
      offset: z.number().int().min(0).default(0).describe('Char offset to start reading from'),
      limit: z.number().int().min(1).max(16000).default(4000).describe('Max chars to return'),
      grep: z.string().optional().describe('Regex pattern to search for. When provided, offset/limit are ignored.'),
    },
    async (params) => {
      const artifact = await db.artifact.findUnique({ where: { id: params.artifactId } });
      if (!artifact || artifact.ticketId !== params.ticketId) {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
      }

      let full: string;
      try {
        const absPath = join(config.ARTIFACT_STORAGE_PATH, artifact.storagePath);
        full = await readFile(absPath, 'utf-8');
      } catch {
        return { content: [{ type: 'text', text: 'ERROR: artifact not found or not accessible' }] };
      }

      if (params.grep) {
        let regex: RegExp;
        try {
          regex = new RegExp(params.grep);
        } catch (err) {
          return { content: [{ type: 'text', text: `ERROR: invalid regex pattern: ${err instanceof Error ? err.message : String(err)}` }] };
        }
        const lines = full.split('\n');
        const matches: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) matches.push(`line ${i + 1}: ${lines[i]}`);
        }
        const body = matches.length > 0 ? matches.join('\n') : `No matches for pattern: ${params.grep}`;
        const footer = matches.length > 0 ? `\n\n[matched ${matches.length} lines of ${lines.length} total]` : '';
        return { content: [{ type: 'text', text: `${body}${footer}` }] };
      }

      const slice = full.slice(params.offset, params.offset + params.limit);
      const footer = `\n\n[returned ${slice.length} chars at offset ${params.offset} of total ${full.length}]`;
      return { content: [{ type: 'text', text: `${slice}${footer}` }] };
    },
  );
}
