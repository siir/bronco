import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerProbeTools(server: McpServer, { db, probeQueue }: ServerDeps): void {
  server.tool(
    'search_scheduled_probes',
    'Search scheduled probes by name, description, or client. Returns a lightweight projection for UI pickers.',
    {
      q: z.string().min(2).describe('Search query (name, description, or client). Must be at least 2 characters.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 20)'),
    },
    async (params) => {
      const { q, limit = 20 } = params;
      const qLower = q.toLowerCase();

      const results = await db.scheduledProbe.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { description: { contains: q, mode: 'insensitive' as const } },
            { client: { name: { contains: q, mode: 'insensitive' as const } } },
            { client: { shortCode: { contains: q, mode: 'insensitive' as const } } },
          ],
        },
        select: {
          id: true,
          name: true,
          createdAt: true,
          clientId: true,
          toolName: true,
          isActive: true,
          client: { select: { name: true, shortCode: true } },
        },
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
      });

      results.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;

        const createdAtDiff = b.createdAt.getTime() - a.createdAt.getTime();
        if (createdAtDiff !== 0) return createdAtDiff;

        return a.name.localeCompare(b.name);
      });

      const result = results.slice(0, limit).map(p => ({
        id: p.id,
        name: p.name,
        clientId: p.clientId,
        clientName: p.client.name,
        clientShortCode: p.client.shortCode,
        toolName: p.toolName,
        isActive: p.isActive,
      }));

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'list_probes',
    'List scheduled probes with last run info. Optionally filter by client.',
    {
      clientId: z.string().uuid().optional().describe('Filter by client ID'),
    },
    async (params) => {
      const where: Record<string, unknown> = {};
      if (params.clientId) where.clientId = params.clientId;

      const probes = await db.scheduledProbe.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          toolName: true,
          cronExpression: true,
          category: true,
          action: true,
          isActive: true,
          lastRunAt: true,
          lastRunStatus: true,
          client: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
      });

      return { content: [{ type: 'text', text: JSON.stringify(probes, null, 2) }] };
    },
  );

  server.tool(
    'run_probe',
    'Enqueue a scheduled probe for immediate execution.',
    {
      probeId: z.string().uuid().describe('The probe ID to run'),
    },
    async (params) => {
      const probe = await db.scheduledProbe.findUniqueOrThrow({
        where: { id: params.probeId },
        select: { id: true, name: true, isActive: true },
      });

      await probeQueue.add('run-probe', { probeId: params.probeId, triggeredBy: 'manual' });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ message: `Probe "${probe.name}" enqueued for execution`, probeId: probe.id }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_probe_runs',
    'Get recent probe run history with step results.',
    {
      probeId: z.string().uuid().describe('The probe ID'),
      limit: z.number().int().min(1).max(50).optional().describe('Max runs to return (default 10)'),
    },
    async (params) => {
      const runs = await db.probeRun.findMany({
        where: { probeId: params.probeId },
        include: {
          steps: { orderBy: { stepOrder: 'asc' } },
        },
        orderBy: { startedAt: 'desc' },
        take: params.limit ?? 10,
      });

      return { content: [{ type: 'text', text: JSON.stringify(runs, null, 2) }] };
    },
  );
}
