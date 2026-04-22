// Re-exported from @bronco/shared-utils so that existing internal imports
// (system-status.ts → normalizeUrl, tool-request-dedupe.ts → discoverMcpServer)
// continue to resolve without modification.
export {
  normalizeUrl,
  discoverMcpServer,
} from '@bronco/shared-utils';
export type {
  McpDiscoveryConfig,
  McpToolInfo,
  McpDiscoveryResult,
} from '@bronco/shared-utils';
