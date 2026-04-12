import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerPeopleTools(server: McpServer, { db }: ServerDeps): void {
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
