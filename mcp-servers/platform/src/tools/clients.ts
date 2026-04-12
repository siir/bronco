import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerClientTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_clients',
    'List all clients with system count and ticket count.',
    {},
    async () => {
      const clients = await db.client.findMany({
        select: {
          id: true,
          name: true,
          shortCode: true,
          isActive: true,
          aiMode: true,
          createdAt: true,
          _count: {
            select: {
              systems: true,
              tickets: true,
              people: true,
            },
          },
        },
        orderBy: { name: 'asc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(clients, null, 2) }] };
    },
  );

  server.tool(
    'get_client',
    'Get full client detail with systems, people, and integrations.',
    {
      clientId: z.string().uuid().describe('The client ID'),
    },
    async (params) => {
      const client = await db.client.findUniqueOrThrow({
        where: { id: params.clientId },
        include: {
          systems: {
            select: { id: true, name: true, dbEngine: true, host: true, environment: true, isActive: true },
          },
          people: {
            select: { id: true, name: true, email: true, phone: true, role: true, isPrimary: true },
          },
          integrations: {
            select: { id: true, type: true, label: true, isActive: true, notes: true },
          },
          environments: {
            select: { id: true, name: true, tag: true, isDefault: true, isActive: true },
          },
        },
      });

      return { content: [{ type: 'text', text: JSON.stringify(client, null, 2) }] };
    },
  );

  server.tool(
    'update_client',
    'Update client fields such as name, notes, or company profile.',
    {
      clientId: z.string().uuid().describe('The client ID'),
      name: z.string().optional().describe('New client name'),
      notes: z.string().optional().describe('Client notes'),
    },
    async (params) => {
      const { clientId, ...fields } = params;
      const data: Record<string, unknown> = {};
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.notes !== undefined) data.notes = fields.notes;

      const client = await db.client.update({ where: { id: clientId }, data });
      return { content: [{ type: 'text', text: JSON.stringify(client, null, 2) }] };
    },
  );
}
