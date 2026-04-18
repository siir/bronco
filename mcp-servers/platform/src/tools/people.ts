import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

// TODO: #219 Wave 2B — rewrite the people tools for the unified
// Person + ClientUser model. Wave 1 keeps read-only discovery working via
// joins through ClientUser; create/update return a 501-style message so
// callers learn that write operations are temporarily disabled.
export function registerPeopleTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'search_people',
    'Search people by name, email, or client. Returns a lightweight projection for UI pickers.',
    {
      q: z.string().min(2).describe('Search query (name, email, or client). Must be at least 2 characters.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
    },
    async (params) => {
      const { q, limit = 20 } = params;
      const qLower = q.toLowerCase();

      const clientUsers = await db.clientUser.findMany({
        where: {
          person: {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          },
        },
        select: {
          id: true,
          clientId: true,
          userType: true,
          isPrimary: true,
          person: { select: { id: true, name: true, email: true, isActive: true } },
          client: { select: { name: true, shortCode: true } },
        },
        take: limit,
        orderBy: { person: { name: 'asc' } },
      });

      const result = clientUsers
        .map((cu) => ({
          id: cu.person.id,
          name: cu.person.name,
          email: cu.person.email,
          clientId: cu.clientId,
          clientName: cu.client.name,
          clientShortCode: cu.client.shortCode,
          role: null as string | null,
          isActive: cu.person.isActive,
        }))
        .sort((a, b) => {
          const aExact = a.email.toLowerCase() === qLower ? 0 : 1;
          const bExact = b.email.toLowerCase() === qLower ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
          const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
          return a.name.localeCompare(b.name);
        });

      return { content: [{ type: 'text', text: JSON.stringify(result.slice(0, limit), null, 2) }] };
    },
  );

  server.tool(
    'list_people',
    'List people, optionally filtered by client. Returns ClientUser-joined rows.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
    },
    async (params) => {
      const clientUsers = await db.clientUser.findMany({
        where: params.clientId ? { clientId: params.clientId } : {},
        include: { person: true, client: { select: { name: true } } },
        orderBy: { person: { name: 'asc' } },
      });

      return { content: [{ type: 'text', text: JSON.stringify(clientUsers, null, 2) }] };
    },
  );

  const writeDisabled = async () => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error:
              'People create/update via MCP is temporarily disabled while #219 Wave 2B rewrites it for the unified Person + ClientUser model.',
            todo: '#219 Wave 2B',
          },
          null,
          2,
        ),
      },
    ],
  });

  server.tool(
    'create_person',
    'Create a new person (disabled during #219 Wave 2B migration).',
    { clientId: z.string().uuid(), name: z.string(), email: z.string().email() },
    writeDisabled,
  );

  server.tool(
    'update_person',
    'Update an existing person (disabled during #219 Wave 2B migration).',
    { personId: z.string().uuid() },
    writeDisabled,
  );
}
