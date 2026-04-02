import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerSystemTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'list_systems',
    'List database systems with engine, host, environment, and status. Optionally filter by client.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;

      const systems = await db.system.findMany({
        where,
        select: {
          id: true,
          name: true,
          dbEngine: true,
          host: true,
          port: true,
          environment: true,
          isActive: true,
          defaultDatabase: true,
          lastConnectedAt: true,
          client: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(systems, null, 2) }] };
    },
  );

  server.tool(
    'get_system',
    'Get system detail (no password exposed).',
    {
      systemId: z.string().uuid().describe('The system ID'),
    },
    async (params) => {
      const system = await db.system.findUniqueOrThrow({
        where: { id: params.systemId },
        select: {
          id: true,
          name: true,
          dbEngine: true,
          host: true,
          port: true,
          instanceName: true,
          defaultDatabase: true,
          authMethod: true,
          username: true,
          useTls: true,
          trustServerCert: true,
          connectionTimeout: true,
          requestTimeout: true,
          maxPoolSize: true,
          isActive: true,
          environment: true,
          notes: true,
          lastConnectedAt: true,
          createdAt: true,
          client: { select: { id: true, name: true, shortCode: true } },
        },
      });

      return { content: [{ type: 'text', text: JSON.stringify(system, null, 2) }] };
    },
  );
}
