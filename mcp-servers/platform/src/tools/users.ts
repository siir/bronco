import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerUserTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'search_users',
    'Search control panel users by name or email. Returns a lightweight projection for UI pickers.',
    {
      q: z.string().min(2).describe('Search query (name or email). Must be at least 2 characters.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
    },
    async (params) => {
      const { q, limit = 20 } = params;
      const qLower = q.toLowerCase();

      const results = await db.user.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
        },
        take: limit,
        orderBy: { name: 'asc' },
      });

      results.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        return aStarts - bStarts;
      });

      return { content: [{ type: 'text', text: JSON.stringify(results.slice(0, limit), null, 2) }] };
    },
  );
}
