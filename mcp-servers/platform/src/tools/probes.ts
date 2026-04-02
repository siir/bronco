import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';

export function registerProbeTools(server: McpServer, { db, probeQueue }: ServerDeps): void {
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
