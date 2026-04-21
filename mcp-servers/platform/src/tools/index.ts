import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { registerTicketTools } from './tickets.js';
import { registerPeopleTools } from './people.js';
import { registerClientTools } from './clients.js';
import { registerSystemTools } from './systems.js';
import { registerProbeTools } from './probes.js';
import { registerIssueJobTools } from './issue-jobs.js';
import { registerAiUsageTools } from './ai-usage.js';
import { registerOperatorTools } from './operators.js';
import { registerIntegrationTools } from './integrations.js';
import { registerClientMemoryTools } from './client-memory.js';
import { registerSettingsTools } from './settings.js';
import { registerSystemStatusTools } from './system-status.js';
import { registerSlackConversationTools } from './slack-conversations.js';
import { registerUserTools } from './users.js';
import { registerArtifactTools } from './read-tool-result-artifact.js';
import { registerRequestToolTool } from './request-tool.js';
import { registerToolRequestTools } from './tool-requests.js';

export function registerAllTools(server: McpServer, deps: ServerDeps): void {
  registerTicketTools(server, deps);
  registerPeopleTools(server, deps);
  registerClientTools(server, deps);
  registerUserTools(server, deps);
  registerSystemTools(server, deps);
  registerProbeTools(server, deps);
  registerIssueJobTools(server, deps);
  registerAiUsageTools(server, deps);
  registerOperatorTools(server, deps);
  registerIntegrationTools(server, deps);
  registerClientMemoryTools(server, deps);
  registerSettingsTools(server, deps);
  registerSystemStatusTools(server, deps);
  registerSlackConversationTools(server, deps);
  registerArtifactTools(server, deps);
  registerRequestToolTool(server, deps);
  registerToolRequestTools(server, deps);
}
