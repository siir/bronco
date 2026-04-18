import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';
import { ClientUserType } from '@bronco/shared-types';

// Explicit Person select — never expose passwordHash or emailLower to MCP callers.
const PERSON_SELECT = { id: true, name: true, email: true, phone: true, isActive: true } as const;

const CLIENT_USER_SELECT = {
  id: true,
  clientId: true,
  userType: true,
  isPrimary: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

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
        select: {
          ...CLIENT_USER_SELECT,
          person: { select: PERSON_SELECT },
          client: { select: { name: true } },
        },
        orderBy: { person: { name: 'asc' } },
      });

      return { content: [{ type: 'text', text: JSON.stringify(clientUsers, null, 2) }] };
    },
  );

  server.tool(
    'get_person',
    'Get a person by their Person ID. Returns all ClientUser associations for the person.',
    {
      personId: z.string().uuid().describe('Person ID'),
    },
    async (params) => {
      const person = await db.person.findUnique({
        where: { id: params.personId },
        select: {
          ...PERSON_SELECT,
          createdAt: true,
          updatedAt: true,
          clientUsers: {
            select: {
              ...CLIENT_USER_SELECT,
              client: { select: { name: true, shortCode: true } },
            },
            // Deterministic: primary first, then oldest.
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
        },
      });

      if (!person) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Person not found' }, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(person, null, 2) }] };
    },
  );

  server.tool(
    'create_person',
    'Create a new person, optionally attaching them to a client as a ClientUser in a single transaction. ' +
      'If a Person with the given email already exists and clientId is supplied, a new ClientUser is added for that client.',
    {
      name: z.string().min(1).describe('Full name'),
      email: z.string().email().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
      clientId: z.string().uuid().optional().describe('Client to attach the person to'),
      userType: z.enum([ClientUserType.ADMIN, ClientUserType.USER]).optional().describe('ClientUser type (default USER)'),
      isPrimary: z.boolean().optional().describe('Mark as primary contact for the client'),
    },
    async (params) => {
      const { name, email, phone, clientId, userType, isPrimary } = params;
      const emailLower = email.trim().toLowerCase();

      const existingPerson = await db.person.findUnique({
        where: { emailLower },
        select: { id: true },
      });

      if (existingPerson) {
        if (!clientId) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'A person with this email already exists.' }, null, 2) }],
          };
        }
        const existingCu = await db.clientUser.findUnique({
          where: { personId_clientId: { personId: existingPerson.id, clientId } },
        });
        if (existingCu) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'This person is already linked to that client.' }, null, 2) }],
          };
        }
      }

      const result = await db.$transaction(async (tx) => {
        const person = existingPerson
          ? await tx.person.update({
              where: { id: existingPerson.id },
              data: { name: name.trim(), isActive: true },
              select: { ...PERSON_SELECT, createdAt: true, updatedAt: true },
            })
          : await tx.person.create({
              data: {
                email: email.trim(),
                emailLower,
                name: name.trim(),
                ...(phone !== undefined && { phone: phone.trim() || null }),
              },
              select: { ...PERSON_SELECT, createdAt: true, updatedAt: true },
            });

        let clientUser = null;
        if (clientId) {
          clientUser = await tx.clientUser.create({
            data: {
              personId: person.id,
              clientId,
              userType: (userType as ClientUserType) ?? ClientUserType.USER,
              ...(isPrimary !== undefined && { isPrimary }),
            },
            select: CLIENT_USER_SELECT,
          });
        }

        return { person, clientUser };
      });

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'update_person',
    'Update a person\'s fields and optionally their ClientUser association for a specific client.',
    {
      personId: z.string().uuid().describe('Person ID to update'),
      name: z.string().optional().describe('New name'),
      phone: z.string().nullable().optional().describe('New phone number (null to clear)'),
      isActive: z.boolean().optional().describe('Activate or deactivate the person'),
      clientId: z.string().uuid().optional().describe('Client context for updating ClientUser fields (validates tenant membership)'),
      userType: z.enum([ClientUserType.ADMIN, ClientUserType.USER]).optional().describe('New ClientUser type (requires clientId)'),
      isPrimary: z.boolean().optional().describe('Set as primary contact for the client (requires clientId)'),
    },
    async (params) => {
      const { personId, name, phone, isActive, clientId, userType, isPrimary } = params;

      const existing = await db.person.findUnique({
        where: { id: personId },
        select: { id: true },
      });
      if (!existing) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Person not found' }, null, 2) }] };
      }

      // Tenant validation: if clientId is given, confirm the person belongs to that client.
      if (clientId) {
        const cu = await db.clientUser.findUnique({
          where: { personId_clientId: { personId, clientId } },
        });
        if (!cu) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Person is not linked to the specified client.' }, null, 2) }],
          };
        }
      }

      const result = await db.$transaction(async (tx) => {
        const person = await tx.person.update({
          where: { id: personId },
          data: {
            ...(name !== undefined && { name: name.trim() }),
            ...(phone !== undefined && { phone: phone ? phone.trim() : null }),
            ...(isActive !== undefined && { isActive }),
          },
          select: { ...PERSON_SELECT, createdAt: true, updatedAt: true },
        });

        let clientUser = null;
        if (clientId && (userType !== undefined || isPrimary !== undefined)) {
          const cu = await db.clientUser.findUnique({
            where: { personId_clientId: { personId, clientId } },
          });
          if (cu) {
            clientUser = await tx.clientUser.update({
              where: { id: cu.id },
              data: {
                ...(userType !== undefined && { userType: userType as ClientUserType }),
                ...(isPrimary !== undefined && { isPrimary }),
              },
              select: CLIENT_USER_SELECT,
            });
          }
        }

        return { person, clientUser };
      });

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'delete_person',
    'Soft-delete a person (set isActive=false), or when clientId is provided remove only that ClientUser association. ' +
      'After removing a ClientUser, if the person has no remaining access records they are also deactivated.',
    {
      personId: z.string().uuid().describe('Person ID'),
      clientId: z.string().uuid().optional().describe('If provided, removes only the ClientUser for this client instead of deactivating the person globally.'),
    },
    async (params) => {
      const { personId, clientId } = params;

      const person = await db.person.findUnique({
        where: { id: personId },
        select: { id: true },
      });
      if (!person) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Person not found' }, null, 2) }] };
      }

      if (clientId) {
        const cu = await db.clientUser.findUnique({
          where: { personId_clientId: { personId, clientId } },
        });
        if (!cu) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Person is not linked to the specified client.' }, null, 2) }],
          };
        }

        await db.$transaction(async (tx) => {
          await tx.clientUser.delete({ where: { id: cu.id } });

          // If Person has no remaining ClientUser rows and no Operator record,
          // they can't authenticate at all — deactivate them.
          const remaining = await tx.person.findUnique({
            where: { id: personId },
            select: {
              operator: { select: { id: true } },
              _count: { select: { clientUsers: true } },
            },
          });
          if (remaining && !remaining.operator && remaining._count.clientUsers === 0) {
            await tx.person.update({ where: { id: personId }, data: { isActive: false } });
          }
        });

        return { content: [{ type: 'text', text: JSON.stringify({ message: 'ClientUser association removed.' }, null, 2) }] };
      }

      // Global soft delete — deactivate the person across all access.
      await db.person.update({ where: { id: personId }, data: { isActive: false } });
      return { content: [{ type: 'text', text: JSON.stringify({ message: 'Person deactivated.' }, null, 2) }] };
    },
  );
}
