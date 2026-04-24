import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';
import { SAFE_PERSON_SELECT } from './selects.js';

export function registerClientTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'search_clients',
    'Search clients by name or short code. Returns a lightweight projection for UI pickers.',
    {
      q: z.string().min(2).describe('Search query (name or short code). Must be at least 2 characters.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
    },
    async (params) => {
      const { q, limit = 20 } = params;
      const qLower = q.toLowerCase();

      const results = await db.client.findMany({
        where: {
          isInternal: false,
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { shortCode: { contains: q, mode: 'insensitive' as const } },
          ],
        },
        select: {
          id: true,
          name: true,
          shortCode: true,
          isActive: true,
        },
        take: limit * 2,
        orderBy: { name: 'asc' },
      });

      const getRank = (name: string, shortCode: string): number => {
        const nameLower = name.toLowerCase();
        const shortCodeLower = shortCode.toLowerCase();
        if (shortCodeLower === qLower) return 0;
        if (shortCodeLower.startsWith(qLower)) return 1;
        if (nameLower === qLower) return 2;
        if (nameLower.startsWith(qLower)) return 3;
        return 4;
      };
      results.sort((a, b) => {
        const rankDiff = getRank(a.name, a.shortCode) - getRank(b.name, b.shortCode);
        if (rankDiff !== 0) return rankDiff;
        return a.name.localeCompare(b.name);
      });

      return { content: [{ type: 'text', text: JSON.stringify(results.slice(0, limit), null, 2) }] };
    },
  );

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
              clientUsers: true,
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
          clientUsers: {
            select: {
              id: true,
              userType: true,
              isPrimary: true,
              person: { select: SAFE_PERSON_SELECT },
            },
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
