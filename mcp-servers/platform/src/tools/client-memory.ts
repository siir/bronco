import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Prisma } from '@bronco/db';
import type { ServerDeps } from '../server.js';

export function registerClientMemoryTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_client_memory',
    'List client memory entries (operational knowledge, playbooks, tool guidance).',
    {
      clientId: z.string().uuid().describe('The client ID'),
      category: z.string().optional().describe('Filter by ticket category'),
    },
    async (params) => {
      const where: Record<string, unknown> = { clientId: params.clientId, isActive: true };
      if (params.category) where.category = params.category;

      const memories = await db.clientMemory.findMany({
        where,
        orderBy: { sortOrder: 'asc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(memories, null, 2) }] };
    },
  );

  server.tool(
    'create_client_memory',
    'Create a new client memory entry (operational knowledge for AI context injection).',
    {
      clientId: z.string().uuid().describe('The client ID'),
      title: z.string().describe('Memory entry title'),
      content: z.string().describe('Markdown content — the knowledge to inject into AI prompts'),
      memoryType: z.string().describe('Memory type: CONTEXT, PLAYBOOK, or TOOL_GUIDANCE'),
      category: z.string().optional().describe('Optional ticket category scope'),
    },
    async (params) => {
      const data: Prisma.ClientMemoryUncheckedCreateInput = {
        clientId: params.clientId,
        title: params.title,
        content: params.content,
        memoryType: params.memoryType as never,
        source: 'MANUAL',
        ...(params.category && { category: params.category as never }),
      };

      const memory = await db.clientMemory.create({ data });
      return { content: [{ type: 'text', text: JSON.stringify(memory, null, 2) }] };
    },
  );
}
