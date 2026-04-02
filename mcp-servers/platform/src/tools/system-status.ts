import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';

export function registerSystemStatusTools(server: McpServer, { config }: ServerDeps): void {
  server.tool(
    'get_service_health',
    'Get health status of all Bronco platform services by calling the copilot-api system status endpoint.',
    {},
    async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(`${config.COPILOT_API_URL}/api/system-status`, {
          signal: controller.signal,
          headers: config.API_KEY ? { 'x-api-key': config.API_KEY } : {},
        });
        clearTimeout(timeout);

        if (!res.ok) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `HTTP ${res.status}: ${res.statusText}` }, null, 2) }] };
        }

        const data = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Failed to fetch service health: ${message}` }, null, 2) }] };
      }
    },
  );
}
