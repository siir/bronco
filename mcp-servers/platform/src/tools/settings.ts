import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';

export function registerSettingsTools(server: McpServer, { db }: ServerDeps): void {
  server.tool(
    'get_system_settings',
    'Get which platform settings are configured (SMTP, IMAP, Slack — status only, no secrets).',
    {},
    async () => {
      const settings = await db.appSetting.findMany();

      // Return keys and a summary of what's configured, never secret values
      const summary = settings.map((s: { key: string; value: unknown; updatedAt: Date }) => ({
        key: s.key,
        configured: s.value !== null && s.value !== undefined,
        updatedAt: s.updatedAt,
      }));

      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    },
  );

  server.tool(
    'get_analysis_strategy',
    'Get the current ticket analysis strategy configuration.',
    {},
    async () => {
      const setting = await db.appSetting.findUnique({ where: { key: 'analysis_strategy' } });
      if (!setting) {
        return { content: [{ type: 'text', text: JSON.stringify({ strategy: 'default', message: 'No custom analysis strategy configured' }, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(setting.value, null, 2) }] };
    },
  );
}
