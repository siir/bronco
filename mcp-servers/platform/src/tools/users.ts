import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

// TODO: #219 Wave 2B — refresh this tool for the unified Person + Operator
// model. Wave 1 rewrites the query against Person joined to Operator so the
// command palette keeps working; Wave 2B may rename the tool to
// `search_operators`.
export function registerUserTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'search_users',
    'Search control panel users (operators) by name or email. Returns a lightweight projection for UI pickers.',
    {
      q: z.string().min(2).describe('Search query (name or email). Must be at least 2 characters.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
    },
    async (params) => {
      const { q, limit = 20 } = params;
      const qLower = q.toLowerCase();

      const people = await db.person.findMany({
        where: {
          operator: { isNot: null },
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          operator: { select: { role: true } },
        },
        take: limit,
        orderBy: { name: 'asc' },
      });

      const results = people.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        role: p.operator?.role ?? 'STANDARD',
        isActive: p.isActive,
      }));

      const getRank = (u: { name: string; email: string }): number => {
        const nameLower = u.name.toLowerCase();
        const emailLower = u.email.toLowerCase();
        if (emailLower === qLower) return 0;
        if (nameLower.startsWith(qLower) || emailLower.startsWith(qLower)) return 1;
        return 2;
      };
      results.sort((a, b) => {
        const rankDiff = getRank(a) - getRank(b);
        if (rankDiff !== 0) return rankDiff;
        const nameDiff = a.name.localeCompare(b.name);
        if (nameDiff !== 0) return nameDiff;
        return a.email.localeCompare(b.email);
      });

      return { content: [{ type: 'text', text: JSON.stringify(results.slice(0, limit), null, 2) }] };
    },
  );
}
