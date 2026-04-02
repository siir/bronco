import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerContactTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_contacts',
    'List contacts, optionally filtered by client.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;

      const contacts = await db.contact.findMany({
        where,
        include: { client: { select: { name: true } } },
        orderBy: { name: 'asc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(contacts, null, 2) }] };
    },
  );

  server.tool(
    'create_contact',
    'Create a new contact for a client.',
    {
      clientId: z.string().uuid().describe('The client ID'),
      name: z.string().describe('Contact name'),
      email: z.string().email().describe('Contact email'),
      phone: z.string().optional().describe('Contact phone number'),
      role: z.string().optional().describe('Contact role/title'),
    },
    async (params) => {
      const contact = await db.contact.create({ data: params });
      return { content: [{ type: 'text', text: JSON.stringify(contact, null, 2) }] };
    },
  );

  server.tool(
    'update_contact',
    'Update an existing contact.',
    {
      contactId: z.string().uuid().describe('The contact ID'),
      name: z.string().optional().describe('New name'),
      email: z.string().email().optional().describe('New email'),
      phone: z.string().optional().describe('New phone'),
      role: z.string().optional().describe('New role'),
      slackUserId: z.string().optional().describe('Slack user ID'),
    },
    async (params) => {
      const { contactId, ...fields } = params;
      const data: Record<string, unknown> = {};
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.email !== undefined) data.email = fields.email;
      if (fields.phone !== undefined) data.phone = fields.phone;
      if (fields.role !== undefined) data.role = fields.role;
      if (fields.slackUserId !== undefined) data.slackUserId = fields.slackUserId;

      const contact = await db.contact.update({ where: { id: contactId }, data });
      return { content: [{ type: 'text', text: JSON.stringify(contact, null, 2) }] };
    },
  );
}
