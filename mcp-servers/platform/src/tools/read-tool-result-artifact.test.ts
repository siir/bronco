/**
 * Unit tests for read-tool-result-artifact.ts
 *
 * Tests the three read paths:
 *   1. head/tail preview (offset+limit, small file)
 *   2. offset+limit on large file (byte-based)
 *   3. grep mode
 *
 * Uses real temp files so the fs.open / readline paths execute fully.
 * No DB is needed — we stub the Prisma artifact lookup.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerArtifactTools } from './read-tool-result-artifact.js';
import type { ServerDeps } from '../server.js';
import type { PrismaClient } from '@bronco/db';
import type { Config } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'bronco-artifact-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Write content to a temp file and return its relative name (basename). */
async function writeTempFile(name: string, content: string): Promise<string> {
  const absPath = join(tmpDir, name);
  await writeFile(absPath, content, 'utf-8');
  return name; // storagePath is relative to ARTIFACT_STORAGE_PATH
}

/**
 * Build a minimal fake ServerDeps that stubs Prisma's artifact lookup.
 * The fake returns the provided artifact row for any findUnique call, or null.
 */
function makeDeps(
  artifactRow: { id: string; ticketId: string | null; storagePath: string } | null,
  storagePath: string,
): ServerDeps {
  return {
    db: {
      artifact: {
        findUnique: async () => artifactRow,
      },
    } as unknown as PrismaClient,
    config: {
      ARTIFACT_STORAGE_PATH: storagePath,
    } as unknown as Config,
    probeQueue: null as never,
    issueResolveQueue: null as never,
    callerName: 'ticket-analyzer',
  };
}

/**
 * Build a real McpServer with only the artifact tool registered, then call
 * the tool directly by routing through the registered handler.
 *
 * The MCP SDK doesn't expose a direct "call tool by name" API, so we instead
 * invoke the internal tool map. We collect registered handlers in a wrapper.
 */
type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildToolServer(deps: ServerDeps): { callTool: (name: string, params: Record<string, unknown>) => ReturnType<ToolHandler> } {
  // We capture each registered handler by patching server.tool before registration.
  const handlers = new Map<string, ToolHandler>();

  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const originalTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as ToolHandler;
    if (typeof handler === 'function') {
      handlers.set(name, handler);
    }
    return (originalTool as (...a: unknown[]) => unknown)(...args);
  };

  registerArtifactTools(server, deps);

  return {
    callTool: (name: string, params: Record<string, unknown>) => {
      const h = handlers.get(name);
      if (!h) throw new Error(`Tool "${name}" not registered`);
      return h(params);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Artifact not found / wrong ticket — returns error
// ---------------------------------------------------------------------------
describe('read_tool_result_artifact — not found', () => {
  it('returns error when artifact row is null', async () => {
    const { callTool } = buildToolServer(makeDeps(null, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: '00000000-0000-0000-0000-000000000001',
      ticketId: '00000000-0000-0000-0000-000000000002',
      offset: 0,
      limit: 100,
    });
    expect(result.content[0]?.text).toContain('ERROR');
  });

  it('returns error when ticketId does not match artifact row', async () => {
    const fileName = await writeTempFile('artifact-mismatch.txt', 'hello');
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      ticketId: 'bbbbbbbb-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      // Different ticketId — should be denied
      ticketId: 'cccccccc-0000-0000-0000-000000000001',
      offset: 0,
      limit: 100,
    });
    expect(result.content[0]?.text).toContain('ERROR');
  });
});

// ---------------------------------------------------------------------------
// 2. Path traversal defence
// ---------------------------------------------------------------------------
describe('read_tool_result_artifact — path traversal defence', () => {
  it('returns error for a path that escapes the storage root', async () => {
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000002',
      ticketId: 'dddddddd-0000-0000-0000-000000000001',
      storagePath: '../../etc/passwd',
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 0,
      limit: 100,
    });
    expect(result.content[0]?.text).toContain('ERROR');
  });
});

// ---------------------------------------------------------------------------
// 3. Small-file offset+limit path (char-based)
// ---------------------------------------------------------------------------
describe('read_tool_result_artifact — offset+limit (small file)', () => {
  it('returns the full content when offset=0 and limit is large enough', async () => {
    const content = 'Hello, artifact world!';
    const fileName = await writeTempFile('artifact-small.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000003',
      ticketId: 'eeeeeeee-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 0,
      limit: 4000,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(content);
    expect(text).toContain('[returned');
  });

  it('respects offset — skips leading chars', async () => {
    const content = 'ABCDEFGHIJ'; // 10 chars
    const fileName = await writeTempFile('artifact-offset.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000004',
      ticketId: 'ffffffff-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 5,
      limit: 4000,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('FGHIJ');
    expect(text).not.toContain('ABCDE');
  });

  it('respects limit — truncates output', async () => {
    const content = 'ABCDEFGHIJ'; // 10 chars
    const fileName = await writeTempFile('artifact-limit.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000005',
      ticketId: '11111111-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 0,
      limit: 3,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('ABC');
    // 'D' should not appear in the returned slice
    expect(text.split('\n')[0]).not.toContain('D');
  });

  it('footer reports char offset and total for small files', async () => {
    const content = '0123456789';
    const fileName = await writeTempFile('artifact-footer.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000006',
      ticketId: '22222222-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 2,
      limit: 4,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('offset 2');
    expect(text).toContain('total 10');
  });
});

// ---------------------------------------------------------------------------
// 4. Grep mode
// ---------------------------------------------------------------------------
describe('read_tool_result_artifact — grep mode', () => {
  it('returns matching lines with line numbers', async () => {
    const lines = ['alpha', 'beta', 'gamma', 'alpha again', 'delta'];
    const content = lines.join('\n');
    const fileName = await writeTempFile('artifact-grep.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000007',
      ticketId: '33333333-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 0,
      limit: 4000,
      grep: 'alpha',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('line 1: alpha');
    expect(text).toContain('line 4: alpha again');
    expect(text).not.toContain('beta');
    expect(text).not.toContain('gamma');
  });

  it('returns "No matches" when pattern does not match any line', async () => {
    const content = 'line one\nline two\nline three';
    const fileName = await writeTempFile('artifact-nomatches.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000008',
      ticketId: '44444444-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 0,
      limit: 4000,
      grep: 'zzznomatch',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('No matches');
  });

  it('returns an error for an invalid regex pattern', async () => {
    const content = 'any content';
    const fileName = await writeTempFile('artifact-badregex.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000009',
      ticketId: '55555555-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 0,
      limit: 4000,
      grep: '[invalid regex(',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('ERROR: invalid regex');
  });

  it('footer includes total lines and match count', async () => {
    const content = 'hit\nmiss\nhit\nmiss\nhit';
    const fileName = await writeTempFile('artifact-grepfooter.txt', content);
    const artifact = {
      id: 'aaaaaaaa-0000-0000-0000-000000000010',
      ticketId: '66666666-0000-0000-0000-000000000001',
      storagePath: fileName,
    };
    const { callTool } = buildToolServer(makeDeps(artifact, tmpDir));
    const result = await callTool('read_tool_result_artifact', {
      artifactId: artifact.id,
      ticketId: artifact.ticketId,
      offset: 0,
      limit: 4000,
      grep: 'hit',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('matched 3');
    expect(text).toContain('5 total');
  });
});
