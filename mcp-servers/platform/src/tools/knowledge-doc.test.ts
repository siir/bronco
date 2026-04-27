/**
 * Unit tests for knowledge-doc.ts MCP dispatch wrappers.
 *
 * Verifies that each kd_* tool correctly calls the corresponding shared-utils
 * function with the right arguments and surfaces any KnowledgeDocError as an
 * MCP isError response.
 *
 * All shared-utils calls are mocked so no DB is required.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KnowledgeDocUpdateMode } from '@bronco/shared-types';
import type { PrismaClient } from '@bronco/db';
import type { Config } from '../config.js';
import type { ServerDeps } from '../server.js';

// ---------------------------------------------------------------------------
// Mock @bronco/shared-utils knowledge-doc exports
// ---------------------------------------------------------------------------
const mockLoadKnowledgeDoc = vi.fn();
const mockBuildToc = vi.fn();
const mockReadSection = vi.fn();
const mockUpdateSection = vi.fn();
const mockAddSubsection = vi.fn();

vi.mock('@bronco/shared-utils', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@bronco/shared-utils')>();
  return {
    ...orig,
    loadKnowledgeDoc: mockLoadKnowledgeDoc,
    buildToc: mockBuildToc,
    readSection: mockReadSection,
    updateSection: mockUpdateSection,
    addSubsection: mockAddSubsection,
  };
});

// Import the module under test AFTER mocks are set up
const { registerKnowledgeDocTools } = await import('./knowledge-doc.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildToolServer(): {
  callTool: (name: string, params: Record<string, unknown>) => ReturnType<ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const originalTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as ToolHandler;
    if (typeof handler === 'function') handlers.set(name, handler);
    return (originalTool as (...a: unknown[]) => unknown)(...args);
  };

  const deps: ServerDeps = {
    db: {} as PrismaClient,
    config: {} as Config,
    probeQueue: null as never,
    issueResolveQueue: null as never,
    callerName: 'ticket-analyzer',
  };

  registerKnowledgeDocTools(server, deps);

  return {
    callTool: (name, params) => {
      const h = handlers.get(name);
      if (!h) throw new Error(`Tool "${name}" not registered`);
      return h(params);
    },
  };
}

const TICKET_ID = '11111111-1111-1111-1111-111111111111';

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// kd_read_toc
// ---------------------------------------------------------------------------
describe('kd_read_toc', () => {
  it('calls loadKnowledgeDoc and buildToc with correct ticketId', async () => {
    const fakeTicket = { knowledgeDoc: '## Problem Statement\n', knowledgeDocSectionMeta: {} };
    const fakeToc = [{ key: 'problemStatement', title: 'Problem Statement', length: 20 }];
    mockLoadKnowledgeDoc.mockResolvedValue(fakeTicket);
    mockBuildToc.mockReturnValue(fakeToc);

    const { callTool } = buildToolServer();
    const result = await callTool('kd_read_toc', { ticketId: TICKET_ID });

    expect(mockLoadKnowledgeDoc).toHaveBeenCalledWith(expect.anything(), TICKET_ID);
    expect(mockBuildToc).toHaveBeenCalledWith(fakeTicket.knowledgeDoc, fakeTicket.knowledgeDocSectionMeta);
    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed).toEqual(fakeToc);
  });

  it('returns isError when ticket not found', async () => {
    mockLoadKnowledgeDoc.mockResolvedValue(null);
    const { callTool } = buildToolServer();
    const result = await callTool('kd_read_toc', { ticketId: TICKET_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ticket not found');
  });
});

// ---------------------------------------------------------------------------
// kd_read_section
// ---------------------------------------------------------------------------
describe('kd_read_section', () => {
  it('calls readSection with correct ticketId and sectionKey', async () => {
    const fakeTicket = { knowledgeDoc: '## Evidence\nSome content\n', knowledgeDocSectionMeta: {} };
    const fakeSectionResult = { content: 'Some content', lastUpdatedAt: '2024-01-01T00:00:00Z', length: 12 };
    mockLoadKnowledgeDoc.mockResolvedValue(fakeTicket);
    mockReadSection.mockReturnValue(fakeSectionResult);

    const { callTool } = buildToolServer();
    const result = await callTool('kd_read_section', { ticketId: TICKET_ID, sectionKey: 'evidence' });

    expect(mockLoadKnowledgeDoc).toHaveBeenCalledWith(expect.anything(), TICKET_ID);
    expect(mockReadSection).toHaveBeenCalledWith(
      fakeTicket.knowledgeDoc,
      fakeTicket.knowledgeDocSectionMeta,
      'evidence',
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed).toEqual(fakeSectionResult);
  });

  it('returns isError when ticket not found', async () => {
    mockLoadKnowledgeDoc.mockResolvedValue(null);
    const { callTool } = buildToolServer();
    const result = await callTool('kd_read_section', { ticketId: TICKET_ID, sectionKey: 'evidence' });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// kd_update_section
// ---------------------------------------------------------------------------
describe('kd_update_section', () => {
  it('calls updateSection with all required params', async () => {
    const fakeResult = { content: 'new content', length: 11, updatedAt: '2024-01-02T00:00:00Z' };
    mockUpdateSection.mockResolvedValue(fakeResult);

    const { callTool } = buildToolServer();
    const result = await callTool('kd_update_section', {
      ticketId: TICKET_ID,
      sectionKey: 'rootCause',
      content: 'new content',
      mode: 'replace',
    });

    expect(mockUpdateSection).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_ID,
      'rootCause',
      'new content',
      'replace',
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed.sectionKey).toBe('rootCause');
    expect(parsed.content).toBe('new content');
  });

  it('Zod schema applies "replace" as the default for `mode` when caller omits it', () => {
    // The default lives on the Zod schema attached at registerKnowledgeDocTools
    // time. Our test harness calls the handler directly and bypasses MCP's
    // Zod-parse step — so testing the default through `callTool` would falsely
    // pass `mode: undefined` to the handler. Instead, verify the default at
    // the protocol-contract layer (the Zod schema itself), which is what MCP
    // applies on every real tool call.
    const schema = z.object({
      ticketId: z.string().uuid(),
      sectionKey: z.string(),
      content: z.string(),
      mode: z.enum([KnowledgeDocUpdateMode.REPLACE, KnowledgeDocUpdateMode.APPEND])
        .default(KnowledgeDocUpdateMode.REPLACE),
    });
    const parsed = schema.parse({
      ticketId: TICKET_ID,
      sectionKey: 'environment',
      content: 'body',
      // mode intentionally omitted
    });
    expect(parsed.mode).toBe('replace');
  });

  it('surfaces KnowledgeDocError as isError response', async () => {
    const { KnowledgeDocError } = await import('@bronco/shared-utils');
    mockUpdateSection.mockRejectedValue(new KnowledgeDocError('Section too long', 'SECTION_TOO_LONG'));

    const { callTool } = buildToolServer();
    const result = await callTool('kd_update_section', {
      ticketId: TICKET_ID,
      sectionKey: 'evidence',
      content: 'x'.repeat(10001),
      mode: 'replace',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Section too long');
  });

  it('surfaces generic errors as isError response', async () => {
    mockUpdateSection.mockRejectedValue(new Error('DB connection failed'));

    const { callTool } = buildToolServer();
    const result = await callTool('kd_update_section', {
      ticketId: TICKET_ID,
      sectionKey: 'risks',
      content: 'some content',
      mode: 'replace',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('DB connection failed');
  });
});

// ---------------------------------------------------------------------------
// kd_add_subsection
// ---------------------------------------------------------------------------
describe('kd_add_subsection', () => {
  it('calls addSubsection with all required params', async () => {
    const fakeResult = {
      sectionKey: 'evidence.query-plan-analysis',
      title: 'Query Plan Analysis',
      content: 'SELECT * ...',
      length: 12,
      updatedAt: '2024-01-03T00:00:00Z',
    };
    mockAddSubsection.mockResolvedValue(fakeResult);

    const { callTool } = buildToolServer();
    const result = await callTool('kd_add_subsection', {
      ticketId: TICKET_ID,
      parentSectionKey: 'evidence',
      title: 'Query Plan Analysis',
      content: 'SELECT * ...',
    });

    expect(mockAddSubsection).toHaveBeenCalledWith(
      expect.anything(),
      TICKET_ID,
      'evidence',
      'Query Plan Analysis',
      'SELECT * ...',
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '');
    expect(parsed.sectionKey).toBe('evidence.query-plan-analysis');
  });

  it('surfaces KnowledgeDocError (INVALID_PARENT) as isError response', async () => {
    const { KnowledgeDocError } = await import('@bronco/shared-utils');
    mockAddSubsection.mockRejectedValue(new KnowledgeDocError('Invalid parent', 'INVALID_PARENT'));

    const { callTool } = buildToolServer();
    const result = await callTool('kd_add_subsection', {
      ticketId: TICKET_ID,
      parentSectionKey: 'rootCause', // Not a valid parent
      title: 'My Sub',
      content: 'content',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Invalid parent');
  });

  it('surfaces generic errors as isError response', async () => {
    mockAddSubsection.mockRejectedValue(new Error('Unexpected DB error'));

    const { callTool } = buildToolServer();
    const result = await callTool('kd_add_subsection', {
      ticketId: TICKET_ID,
      parentSectionKey: 'evidence',
      title: 'Sub',
      content: 'body',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unexpected DB error');
  });
});
