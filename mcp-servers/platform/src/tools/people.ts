import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerPeopleTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'search_people',
    'Search people (unified contacts + portal users) by name, email, or client. Returns a lightweight projection for UI pickers.',
    {
      q: z.string().min(2).describe('Search query (name, email, or client). Must be at least 2 characters.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
    },
    async (params) => {
      const { q, limit = 20 } = params;
      const qLower = q.toLowerCase();

      const results = await db.person.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
            { client: { name: { contains: q, mode: 'insensitive' as const } } },
            { client: { shortCode: { contains: q, mode: 'insensitive' as const } } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          clientId: true,
          role: true,
          isActive: true,
          client: { select: { name: true, shortCode: true } },
        },
        take: limit,
        orderBy: { name: 'asc' },
      });

      results.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        return aStarts - bStarts;
      });

      const result = results.slice(0, limit).map(p => ({
        id: p.id,
        name: p.name,
        email: p.email,
        clientId: p.clientId,
        clientName: p.client.name,
        clientShortCode: p.client.shortCode,
        role: p.role,
        isActive: p.isActive,
      }));

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'list_people',
    'List people (unified contacts + portal users), optionally filtered by client.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;

      const people = await db.person.findMany({
        where,
        include: { client: { select: { name: true } } },
        orderBy: { name: 'asc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(people, null, 2) }] };
    },
  );

  server.tool(
    'create_person',
    'Create a new person (unified contact + portal user) for a client.',
    {
      clientId: z.string().uuid().describe('The client ID'),
      name: z.string().describe('Person name'),
      email: z.string().email().describe('Person email'),
      phone: z.string().optional().describe('Phone number'),
      role: z.string().optional().describe('Role/title'),
      slackUserId: z.string().optional().describe('Slack user ID'),
      isPrimary: z.boolean().optional().describe('Whether this is the primary contact for the client'),
      hasPortalAccess: z.boolean().optional().describe('Whether this person can log into the portal'),
      userType: z.enum(['ADMIN', 'USER']).optional().describe('Portal user type: ADMIN or USER'),
      isActive: z.boolean().optional().describe('Whether this person is active'),
    },
    async (params) => {
      const { clientId, name, email, ...fields } = params;
      const data: Record<string, unknown> = { clientId, name, email };
      if (fields.phone !== undefined) data.phone = fields.phone;
      if (fields.role !== undefined) data.role = fields.role;
      if (fields.slackUserId !== undefined) data.slackUserId = fields.slackUserId;
      if (fields.isPrimary !== undefined) data.isPrimary = fields.isPrimary;
      if (fields.hasPortalAccess !== undefined) data.hasPortalAccess = fields.hasPortalAccess;
      if (fields.userType !== undefined) data.userType = fields.userType;
      if (fields.isActive !== undefined) data.isActive = fields.isActive;

      const person = await db.person.create({ data: data as never });
      return { content: [{ type: 'text', text: JSON.stringify(person, null, 2) }] };
    },
  );

  server.tool(
    'update_person',
    'Update an existing person (unified contact + portal user).',
    {
      personId: z.string().uuid().describe('The person ID'),
      name: z.string().optional().describe('New name'),
      email: z.string().email().optional().describe('New email'),
      phone: z.string().optional().describe('New phone'),
      role: z.string().optional().describe('New role'),
      slackUserId: z.string().optional().describe('Slack user ID'),
      isPrimary: z.boolean().optional().describe('Whether this is the primary contact for the client'),
      hasPortalAccess: z.boolean().optional().describe('Whether this person can log into the portal'),
      userType: z.enum(['ADMIN', 'USER']).optional().describe('Portal user type: ADMIN or USER'),
      isActive: z.boolean().optional().describe('Whether this person is active'),
    },
    async (params) => {
      const { personId, ...fields } = params;
      const data: Record<string, unknown> = {};
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.email !== undefined) data.email = fields.email;
      if (fields.phone !== undefined) data.phone = fields.phone;
      if (fields.role !== undefined) data.role = fields.role;
      if (fields.slackUserId !== undefined) data.slackUserId = fields.slackUserId;
      if (fields.isPrimary !== undefined) data.isPrimary = fields.isPrimary;
      if (fields.hasPortalAccess !== undefined) data.hasPortalAccess = fields.hasPortalAccess;
      if (fields.userType !== undefined) data.userType = fields.userType;
      if (fields.isActive !== undefined) data.isActive = fields.isActive;

      const person = await db.person.update({ where: { id: personId }, data });
      return { content: [{ type: 'text', text: JSON.stringify(person, null, 2) }] };
    },
  );
}
