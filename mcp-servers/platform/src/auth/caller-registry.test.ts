/**
 * Unit tests for caller-registry.ts — allowlist enforcement.
 * Pure logic tests: no DB, no I/O.
 */
import { describe, expect, it } from 'vitest';
import { isCallerAllowed, CALLER_ALLOWLIST } from './caller-registry.js';

// Known caller names that must be present in the registry.
const KNOWN_CALLERS = [
  'ticket-analyzer',
  'slack-worker',
  'probe-worker',
  'devops-worker',
  'issue-resolver',
  'scheduler-worker',
  'copilot-api',
] as const;

// ---------------------------------------------------------------------------
// 1. isCallerAllowed — denial path
// ---------------------------------------------------------------------------
describe('isCallerAllowed — denial path', () => {
  it('returns false for completely unknown caller', () => {
    expect(isCallerAllowed('unknown-service', 'get_ticket')).toBe(false);
  });

  it('returns false for empty string caller', () => {
    expect(isCallerAllowed('', 'get_ticket')).toBe(false);
  });

  it('returns false when caller is known but tool is not in their allowlist', () => {
    // ticket-analyzer should NOT be able to delete operators
    expect(isCallerAllowed('ticket-analyzer', 'delete_operator')).toBe(false);
  });

  it('returns false for ticket-analyzer calling create_person (write op it does not own)', () => {
    expect(isCallerAllowed('ticket-analyzer', 'create_person')).toBe(false);
  });

  it('returns false for probe-worker calling kd_update_section (knowledge-doc write)', () => {
    expect(isCallerAllowed('probe-worker', 'kd_update_section')).toBe(false);
  });

  it('returns false for devops-worker calling read_tool_result_artifact', () => {
    expect(isCallerAllowed('devops-worker', 'read_tool_result_artifact')).toBe(false);
  });

  it('returns false for issue-resolver calling request_tool', () => {
    expect(isCallerAllowed('issue-resolver', 'request_tool')).toBe(false);
  });

  it('returns false for scheduler-worker calling kd_read_toc', () => {
    expect(isCallerAllowed('scheduler-worker', 'kd_read_toc')).toBe(false);
  });

  it('returns false for a caller with valid name but tool with wrong case', () => {
    // Tool names are lowercase with underscores — case-sensitive check.
    expect(isCallerAllowed('ticket-analyzer', 'GET_TICKET')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. isCallerAllowed — happy path for each known caller
// ---------------------------------------------------------------------------
describe('isCallerAllowed — happy path: copilot-api has full access', () => {
  it('copilot-api is allowed to call any tool (ALLOW_ALL)', () => {
    expect(isCallerAllowed('copilot-api', 'get_ticket')).toBe(true);
    expect(isCallerAllowed('copilot-api', 'delete_person')).toBe(true);
    expect(isCallerAllowed('copilot-api', 'kd_update_section')).toBe(true);
    expect(isCallerAllowed('copilot-api', 'run_tool_request_dedupe')).toBe(true);
    // Even a made-up tool name — ALLOW_ALL is unconditional.
    expect(isCallerAllowed('copilot-api', 'totally_unknown_tool')).toBe(true);
  });
});

describe('isCallerAllowed — happy path: ticket-analyzer', () => {
  it('ticket-analyzer can call knowledge-doc tools', () => {
    expect(isCallerAllowed('ticket-analyzer', 'kd_read_toc')).toBe(true);
    expect(isCallerAllowed('ticket-analyzer', 'kd_read_section')).toBe(true);
    expect(isCallerAllowed('ticket-analyzer', 'kd_update_section')).toBe(true);
    expect(isCallerAllowed('ticket-analyzer', 'kd_add_subsection')).toBe(true);
  });

  it('ticket-analyzer can call read_tool_result_artifact', () => {
    expect(isCallerAllowed('ticket-analyzer', 'read_tool_result_artifact')).toBe(true);
  });

  it('ticket-analyzer can call request_tool', () => {
    expect(isCallerAllowed('ticket-analyzer', 'request_tool')).toBe(true);
  });

  it('ticket-analyzer can read tickets', () => {
    expect(isCallerAllowed('ticket-analyzer', 'get_ticket')).toBe(true);
    expect(isCallerAllowed('ticket-analyzer', 'list_tickets')).toBe(true);
    expect(isCallerAllowed('ticket-analyzer', 'search_tickets')).toBe(true);
  });

  it('ticket-analyzer can update_ticket (status transition)', () => {
    expect(isCallerAllowed('ticket-analyzer', 'update_ticket')).toBe(true);
  });
});

describe('isCallerAllowed — happy path: slack-worker', () => {
  it('slack-worker can call ticket and knowledge-doc tools', () => {
    expect(isCallerAllowed('slack-worker', 'get_ticket')).toBe(true);
    expect(isCallerAllowed('slack-worker', 'kd_read_toc')).toBe(true);
    expect(isCallerAllowed('slack-worker', 'kd_update_section')).toBe(true);
  });

  it('slack-worker can create and update people', () => {
    expect(isCallerAllowed('slack-worker', 'create_person')).toBe(true);
    expect(isCallerAllowed('slack-worker', 'update_person')).toBe(true);
    expect(isCallerAllowed('slack-worker', 'get_person')).toBe(true);
  });

  it('slack-worker can run probes', () => {
    expect(isCallerAllowed('slack-worker', 'run_probe')).toBe(true);
  });
});

describe('isCallerAllowed — happy path: probe-worker', () => {
  it('probe-worker can create and read tickets', () => {
    expect(isCallerAllowed('probe-worker', 'create_ticket')).toBe(true);
    expect(isCallerAllowed('probe-worker', 'get_ticket')).toBe(true);
    expect(isCallerAllowed('probe-worker', 'list_tickets')).toBe(true);
  });

  it('probe-worker can read clients', () => {
    expect(isCallerAllowed('probe-worker', 'get_client')).toBe(true);
    expect(isCallerAllowed('probe-worker', 'list_clients')).toBe(true);
  });
});

describe('isCallerAllowed — happy path: devops-worker', () => {
  it('devops-worker can create and manage tickets', () => {
    expect(isCallerAllowed('devops-worker', 'create_ticket')).toBe(true);
    expect(isCallerAllowed('devops-worker', 'update_ticket')).toBe(true);
  });

  it('devops-worker can read operators', () => {
    expect(isCallerAllowed('devops-worker', 'get_operator')).toBe(true);
    expect(isCallerAllowed('devops-worker', 'list_operators')).toBe(true);
  });
});

describe('isCallerAllowed — happy path: issue-resolver', () => {
  it('issue-resolver can manage issue jobs', () => {
    expect(isCallerAllowed('issue-resolver', 'get_issue_job')).toBe(true);
    expect(isCallerAllowed('issue-resolver', 'list_issue_jobs')).toBe(true);
  });

  it('issue-resolver can approve and reject plans', () => {
    expect(isCallerAllowed('issue-resolver', 'approve_plan')).toBe(true);
    expect(isCallerAllowed('issue-resolver', 'reject_plan')).toBe(true);
  });

  it('issue-resolver can write client memory (learner step)', () => {
    expect(isCallerAllowed('issue-resolver', 'create_client_memory')).toBe(true);
  });
});

describe('isCallerAllowed — happy path: scheduler-worker', () => {
  it('scheduler-worker can read tickets and clients', () => {
    expect(isCallerAllowed('scheduler-worker', 'get_ticket')).toBe(true);
    expect(isCallerAllowed('scheduler-worker', 'list_clients')).toBe(true);
  });

  it('scheduler-worker can check service health', () => {
    expect(isCallerAllowed('scheduler-worker', 'get_service_health')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. CALLER_ALLOWLIST registry completeness
// ---------------------------------------------------------------------------
describe('CALLER_ALLOWLIST registry completeness', () => {
  it('contains an entry for every known caller', () => {
    for (const caller of KNOWN_CALLERS) {
      expect(CALLER_ALLOWLIST).toHaveProperty(caller);
    }
  });

  it('copilot-api entry is the ALLOW_ALL sentinel', () => {
    expect(CALLER_ALLOWLIST['copilot-api']).toBe('*');
  });

  it('all worker entries are Set instances (not wildcard)', () => {
    const workers = KNOWN_CALLERS.filter((c) => c !== 'copilot-api');
    for (const worker of workers) {
      expect(CALLER_ALLOWLIST[worker]).toBeInstanceOf(Set);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. withCallerGuard integration — via the tool dispatch layer
// ---------------------------------------------------------------------------
// These tests exercise the full guard by simulating what registerAllTools does
// when the guarded server wraps a handler. We import the index guard logic
// indirectly by testing the isCallerAllowed boundary cases that mirror what
// the guard calls at dispatch time.

describe('guard boundary: tool name precision', () => {
  it('exact tool name match is required — prefix match is not sufficient', () => {
    // "get_tick" is not "get_ticket"
    expect(isCallerAllowed('ticket-analyzer', 'get_tick')).toBe(false);
  });

  it('trailing underscore does not match', () => {
    expect(isCallerAllowed('ticket-analyzer', 'get_ticket_')).toBe(false);
  });
});
