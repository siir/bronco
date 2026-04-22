import { isIP } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Timeout (ms) for MCP tool HTTP requests. */
export const MCP_TOOL_TIMEOUT_MS = 30_000;

/**
 * Allowed pattern for MCP tool names: lowercase kebab-case with underscores.
 * Must start with a letter and contain only lowercase letters, digits, hyphens,
 * and underscores. This prevents path traversal and query injection in URLs.
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** Parse an IPv4 address string into a 32-bit numeric value, or null if invalid. */
function ipv4ToNum(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  // Convert to unsigned 32-bit.
  return num >>> 0;
}

/** Check whether a numeric IPv4 address falls within a CIDR range. */
function ipv4InCidr(ip: number, network: number, prefixLen: number): boolean {
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (network & mask);
}

/**
 * Expand a bracket-stripped IPv6 hostname into its full 8-group form and return
 * the 16-byte representation as a Uint8Array, or null if not a valid IPv6 address.
 */
function ipv6ToBytes(host: string): Uint8Array | null {
  // Strip surrounding brackets if present (URL.hostname uses brackets for IPv6).
  const addr = host.startsWith('[') ? host.slice(1, -1) : host;
  if (isIP(addr) !== 6) return null;

  // Handle IPv4-mapped IPv6 (::ffff:a.b.c.d).
  const v4Suffix = addr.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let groups: string[];
  let extraBytes: number[] = [];
  if (v4Suffix) {
    const prefix = addr.slice(0, addr.length - v4Suffix[0].length);
    groups = expandIpv6Groups(prefix, 6);
    const v4Parts = v4Suffix[1].split('.').map(Number);
    extraBytes = v4Parts;
  } else {
    groups = expandIpv6Groups(addr, 8);
  }

  const bytes = new Uint8Array(16);
  let idx = 0;
  for (const g of groups) {
    const val = parseInt(g, 16);
    bytes[idx++] = (val >> 8) & 0xff;
    bytes[idx++] = val & 0xff;
  }
  for (const b of extraBytes) {
    bytes[idx++] = b;
  }
  return bytes;
}

/** Expand :: in an IPv6 address to produce exactly `targetGroups` hex groups. */
function expandIpv6Groups(addr: string, targetGroups: number): string[] {
  const sides = addr.split('::');
  if (sides.length === 1) {
    // No :: present.
    const groups = addr.split(':').filter(Boolean);
    return groups.map((g) => g.padStart(4, '0'));
  }
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides[1] ? sides[1].split(':') : [];
  const fill = targetGroups - left.length - right.length;
  const groups = [
    ...left.map((g) => g.padStart(4, '0')),
    ...Array.from({ length: fill }, () => '0000'),
    ...right.map((g) => g.padStart(4, '0')),
  ];
  return groups;
}

/** Check if the first `prefixLen` bits of two 16-byte IPv6 addresses match. */
function ipv6InCidr(ip: Uint8Array, network: Uint8Array, prefixLen: number): boolean {
  let remaining = prefixLen;
  for (let i = 0; i < 16; i++) {
    if (remaining <= 0) return true;
    const bits = Math.min(remaining, 8);
    const mask = bits === 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip[i] & mask) !== (network[i] & mask)) return false;
    remaining -= 8;
  }
  return true;
}

/**
 * Reserved IPv4 CIDR ranges that must be blocked for SSRF protection.
 * Each entry is [networkNumeric, prefixLength].
 */
const RESERVED_IPV4_CIDRS: Array<[number, number]> = [
  [ipv4ToNum('127.0.0.0')!, 8],      // Loopback (127.0.0.0/8)
  [ipv4ToNum('10.0.0.0')!, 8],       // Private (10.0.0.0/8)
  [ipv4ToNum('172.16.0.0')!, 12],    // Private (172.16.0.0/12)
  [ipv4ToNum('192.168.0.0')!, 16],   // Private (192.168.0.0/16)
  [ipv4ToNum('169.254.0.0')!, 16],   // Link-local / cloud metadata (169.254.0.0/16)
  [ipv4ToNum('0.0.0.0')!, 8],        // "This" network (0.0.0.0/8)
];

/**
 * Reserved IPv6 CIDR ranges that must be blocked for SSRF protection.
 * Each entry is [networkBytes, prefixLength].
 */
const RESERVED_IPV6_CIDRS: Array<[Uint8Array, number]> = [
  [ipv6ToBytes('::1')!, 128],         // Loopback
  [ipv6ToBytes('fe80::')!, 10],       // Link-local (fe80::/10)
  [ipv6ToBytes('fc00::')!, 7],        // Unique local / private (fc00::/7)
  [ipv6ToBytes('::ffff:0:0')!, 96],   // IPv4-mapped IPv6 (checked separately for the v4 part)
  [ipv6ToBytes('::')!, 128],          // Unspecified address
];

/**
 * Normalise an MCP base URL and reject SSRF-risky destinations.
 *
 * - Accepts a full URL or a bare hostname (defaults to https).
 * - Rejects non-HTTP(S) protocols.
 * - Blocks loopback: localhost, *.local, 127.0.0.0/8, ::1.
 * - Blocks private IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
 * - Blocks link-local / metadata: 169.254.0.0/16 (includes 169.254.169.254).
 * - Blocks reserved IPv6: fe80::/10 (link-local), fc00::/7 (ULA/private).
 * - Blocks IPv4-mapped IPv6 that maps to a reserved IPv4 range.
 * - Strips a single trailing slash.
 */
export function mcpUrl(base: string): string {
  let url: URL;

  // Try to parse the base as a full URL; if that fails, assume https and retry.
  try {
    url = new URL(base);
  } catch {
    try {
      url = new URL(`https://${base}`);
    } catch {
      throw new Error('Invalid MCP base URL');
    }
  }

  // Only allow HTTP(S) protocols for MCP.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported MCP URL protocol: ${url.protocol}`);
  }

  const hostname = url.hostname.toLowerCase();

  // Disallow obvious loopback and local-only hostnames.
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error(`Disallowed MCP host: ${hostname}`);
  }

  // Check IPv4 addresses against all reserved CIDR ranges.
  if (isIP(hostname) === 4) {
    const num = ipv4ToNum(hostname);
    if (num !== null) {
      for (const [network, prefix] of RESERVED_IPV4_CIDRS) {
        if (ipv4InCidr(num, network, prefix)) {
          throw new Error(`Disallowed MCP host (reserved IPv4): ${hostname}`);
        }
      }
    }
  }

  // Check IPv6 addresses (URL.hostname strips brackets for us).
  const ipv6Bytes = ipv6ToBytes(hostname);
  if (ipv6Bytes) {
    // First check direct IPv6 reserved ranges.
    for (const [network, prefix] of RESERVED_IPV6_CIDRS) {
      if (ipv6InCidr(ipv6Bytes, network, prefix)) {
        throw new Error(`Disallowed MCP host (reserved IPv6): ${hostname}`);
      }
    }

    // Also check if this is an IPv4-mapped IPv6 address (::ffff:a.b.c.d)
    // whose embedded IPv4 falls in a reserved range.
    const isV4Mapped = ipv6Bytes[10] === 0xff && ipv6Bytes[11] === 0xff &&
      ipv6Bytes.slice(0, 10).every((b) => b === 0);
    if (isV4Mapped) {
      const embeddedV4 =
        ((ipv6Bytes[12] << 24) | (ipv6Bytes[13] << 16) | (ipv6Bytes[14] << 8) | ipv6Bytes[15]) >>> 0;
      for (const [network, prefix] of RESERVED_IPV4_CIDRS) {
        if (ipv4InCidr(embeddedV4, network, prefix)) {
          throw new Error(`Disallowed MCP host (IPv4-mapped reserved): ${hostname}`);
        }
      }
    }
  }

  // Normalize by removing a single trailing slash from the full URL string.
  return url.toString().replace(/\/$/, '');
}

/**
 * Call an MCP tool on a remote server with authentication.
 *
 * `toolName` is validated against a strict pattern (lowercase kebab-case with
 * underscores) to prevent path traversal and query injection. The request URL
 * is built using the URL constructor for safe path resolution.
 */
export async function callMcpToolWithAuth(
  baseUrl: string,
  toolName: string,
  params: Record<string, unknown>,
  apiKey?: string,
  authHeader?: string,
): Promise<string> {
  // Validate toolName before using it in URL construction.
  if (!TOOL_NAME_RE.test(toolName)) {
    throw new Error(
      `Invalid MCP tool name: "${toolName}". Must match ${TOOL_NAME_RE.source}`,
    );
  }

  const normalizedUrl = mcpUrl(baseUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    if (authHeader === 'x-api-key') {
      headers['X-Api-Key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  // Use URL constructor for safe path building instead of string concatenation.
  const toolUrl = new URL(`tools/${encodeURIComponent(toolName)}`, `${normalizedUrl}/`);

  const res = await fetch(toolUrl.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(MCP_TOOL_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`MCP ${toolName} failed: ${res.status}`);
  }
  const data = await res.json() as { content?: Array<{ text?: string }> };
  return data.content?.map((c) => c.text).join('\n') ?? JSON.stringify(data);
}

/**
 * Call an MCP tool on a remote server using the MCP Streamable HTTP transport.
 *
 * Unlike `callMcpToolWithAuth` (which uses a REST bridge `/tools/<name>` pattern),
 * this function speaks the proper MCP protocol via the SDK's StreamableHTTPClientTransport.
 * Use this for external MCP servers that only expose the `/mcp` endpoint.
 */
export async function callMcpToolViaSdk(
  baseUrl: string,
  mcpPath: string | undefined,
  toolName: string,
  params: Record<string, unknown>,
  apiKey?: string,
  authHeader?: string,
): Promise<string> {
  if (!TOOL_NAME_RE.test(toolName)) {
    throw new Error(
      `Invalid MCP tool name: "${toolName}". Must match ${TOOL_NAME_RE.source}`,
    );
  }

  const resolvedMcpPath = mcpPath ?? '/mcp';
  // Validate that mcpPath is a root-relative path to prevent SSRF via absolute URL injection.
  if (resolvedMcpPath.includes('://') || !resolvedMcpPath.startsWith('/')) {
    throw new Error(`Invalid mcpPath: must be a root-relative path starting with "/" (got "${resolvedMcpPath}")`);
  }

  const normalizedUrl = mcpUrl(baseUrl);
  const baseUrlParsed = new URL(normalizedUrl);
  baseUrlParsed.pathname = resolvedMcpPath;
  const endpointUrl = baseUrlParsed;

  const headers: Record<string, string> = {};
  if (apiKey) {
    if (authHeader === 'x-api-key') {
      headers['x-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  const transport = new StreamableHTTPClientTransport(endpointUrl, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  });

  const client = new Client({ name: 'bronco-tool-caller', version: '0.1.0' });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP tool call timed out after ${MCP_TOOL_TIMEOUT_MS}ms`)),
      MCP_TOOL_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);

    const result = await Promise.race([
      client.callTool({ name: toolName, arguments: params }),
      timeoutPromise,
    ]);

    const contentArray = Array.isArray(result.content) ? result.content : [];
    const texts = contentArray
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { type: string; text: string }) => c.text);
    const joined = texts.join('\n') || JSON.stringify(result);
    // MCP tools may return normally with `isError: true` (input validation,
    // rate-limit rejections, tool-logic errors the server returns as a result
    // rather than throwing). Surface these as thrown exceptions so the agentic
    // caller's catch block can classify them into the structured envelope
    // alongside transport/timeout/auth failures. See #360.
    if (result.isError === true) {
      // Cap the embedded content so high-volume tools (e.g. repo_exec returning
      // full stdout/stderr) don't bloat logs, error envelopes, and agent prompts.
      // Classification patterns we care about (rate_limit / auth / timeout / etc.)
      // land within the first hundred characters in practice.
      const MAX_ERROR_BODY = 2000;
      const truncated = joined.length > MAX_ERROR_BODY
        ? `${joined.slice(0, MAX_ERROR_BODY)} [truncated ${joined.length - MAX_ERROR_BODY} chars]`
        : joined;
      throw new Error(`MCP tool returned isError: ${truncated}`);
    }
    return joined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { await transport.close(); } catch { /* ignore close errors */ }
  }
}
