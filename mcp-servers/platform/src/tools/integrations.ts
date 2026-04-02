import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerIntegrationTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_integrations',
    'List client integrations (type, label, status). Secrets are not exposed.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;

      const integrations = await db.clientIntegration.findMany({
        where,
        select: {
          id: true,
          type: true,
          label: true,
          isActive: true,
          notes: true,
          createdAt: true,
          client: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(integrations, null, 2) }] };
    },
  );
}
