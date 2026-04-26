import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { createLogger } from '@bronco/shared-utils';
import { isCallerAllowed } from '../auth/caller-registry.js';
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
import { registerQueryArtifactTool } from './query-artifact.js';
import { registerRequestToolTool } from './request-tool.js';
import { registerToolRequestTools } from './tool-requests.js';
import { registerKnowledgeDocTools } from './knowledge-doc.js';

const logger = createLogger('mcp-platform:auth');

/**
 * Wrap a McpServer so that every tool call is checked against the per-caller
 * allowlist before the real handler runs.
 *
 * When callerName is null (header absent, grace mode) the check is skipped.
 * When callerName is present and not allowed for the tool, a structured MCP
 * error is returned without invoking the handler.
 */
function withCallerGuard(server: McpServer, callerName: string | null): McpServer {
  if (callerName === null) {
    // Grace mode: no caller identity — allow everything (WARN was already logged).
    return server;
  }

  // Wrap the tool registration method to inject an allowlist check before each handler.
  const originalTool = server.tool.bind(server);

  // Override server.tool to wrap every registered handler with a caller check.
  // The MCP SDK's server.tool() has multiple overloaded signatures; we capture
  // the arguments verbatim and patch the last argument (the handler function)
  // before forwarding to the real implementation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: unknown[]): unknown => {
    // Tool name is always the first argument.
    const toolName = args[0] as string;

    // Handler is always the last argument and must be a function.
    const lastIdx = args.length - 1;
    const originalHandler = args[lastIdx];
    if (typeof originalHandler !== 'function') {
      return (originalTool as (...a: unknown[]) => unknown)(...args);
    }

    // Replace the handler with a guarded version.
    const guardedHandler = async (...handlerArgs: unknown[]): Promise<unknown> => {
      if (!isCallerAllowed(callerName, toolName)) {
        logger.warn(
          { caller: callerName, tool: toolName },
          'MCP tool call denied: caller not in allowlist',
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                _mcp_caller_denied: true,
                caller: callerName,
                tool: toolName,
                message: `Caller "${callerName}" is not authorized to invoke tool "${toolName}".`,
                guidance: 'Contact the platform operator to add this tool to the caller allowlist in caller-registry.ts.',
              }),
            },
          ],
          isError: true,
        };
      }
      return (originalHandler as (...a: unknown[]) => unknown)(...handlerArgs);
    };

    const patchedArgs = [...args.slice(0, lastIdx), guardedHandler];
    return (originalTool as (...a: unknown[]) => unknown)(...patchedArgs);
  };

  return server;
}

export function registerAllTools(server: McpServer, deps: ServerDeps): void {
  const guardedServer = withCallerGuard(server, deps.callerName);

  registerTicketTools(guardedServer, deps);
  registerPeopleTools(guardedServer, deps);
  registerClientTools(guardedServer, deps);
  registerUserTools(guardedServer, deps);
  registerSystemTools(guardedServer, deps);
  registerProbeTools(guardedServer, deps);
  registerIssueJobTools(guardedServer, deps);
  registerAiUsageTools(guardedServer, deps);
  registerOperatorTools(guardedServer, deps);
  registerIntegrationTools(guardedServer, deps);
  registerClientMemoryTools(guardedServer, deps);
  registerSettingsTools(guardedServer, deps);
  registerSystemStatusTools(guardedServer, deps);
  registerSlackConversationTools(guardedServer, deps);
  registerArtifactTools(guardedServer, deps);
  registerQueryArtifactTool(guardedServer, deps);
  registerRequestToolTool(guardedServer, deps);
  registerToolRequestTools(guardedServer, deps);
  registerKnowledgeDocTools(guardedServer, deps);
}
