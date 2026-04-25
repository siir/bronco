/**
 * Integration tests: SAFE_PERSON_SELECT enforcement for every MCP platform tool
 * that returns Person data.
 *
 * For each Person-returning tool we:
 *   1. Seed a Person row that has `passwordHash: 'TEST_HASH_NEVER_LEAK'`
 *      and `emailLower` set.
 *   2. Invoke the tool against a real Postgres DB.
 *   3. Assert the response payload contains ONLY the safe fields
 *      {id, name, email, phone, isActive} and does NOT contain
 *      passwordHash / emailLower / any credential-adjacent field.
 *
 * Requires TEST_DATABASE_URL pointing at a migrated Postgres instance.
 *
 * 🚨 SECURITY: any failure here means a credential-adjacent field is leaking
 *    through an MCP tool response.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@bronco/db';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { ServerDeps } from '../server.js';
import { getTestDb, truncateAll } from '@bronco/test-utils';
import { createClient, createPerson } from '@bronco/test-utils';
import { registerPeopleTools } from './people.js';
import { registerOperatorTools } from './operators.js';
import { registerClientTools } from './clients.js';
import { registerTicketTools } from './tickets.js';

// ---------------------------------------------------------------------------
// Skip suite when no real DB is available (unit-test runs)
// ---------------------------------------------------------------------------
const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

// ---------------------------------------------------------------------------
// Tool harness — intercepts server.tool() calls and records handlers
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildToolServer(
  db: PrismaClient,
  register: (server: McpServer, deps: ServerDeps) => void,
): {
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
    db,
    config: {} as Config,
    probeQueue: null as never,
    issueResolveQueue: null as never,
    callerName: 'test',
  };

  register(server, deps);

  return {
    callTool: (name, params) => {
      const h = handlers.get(name);
      if (!h) throw new Error(`Tool "${name}" not registered`);
      return h(params);
    },
  };
}

/**
 * Assert that no credential-adjacent fields leak anywhere in a JSON payload
 * (including nested objects).
 */
function assertNoCredentialFields(payloadText: string): void {
  const payload = JSON.parse(payloadText) as unknown;
  const text = JSON.stringify(payload);

  // The presence of these strings in the serialized payload is the leak signal.
  expect(text, '🚨 SECURITY: passwordHash leaked').not.toContain('TEST_HASH_NEVER_LEAK');
  expect(text, '🚨 SECURITY: passwordHash key leaked').not.toMatch(/"passwordHash"/);
  expect(text, '🚨 SECURITY: password_hash key leaked').not.toMatch(/"password_hash"/);
  expect(text, '🚨 SECURITY: emailLower leaked').not.toMatch(/"emailLower"/);
  expect(text, '🚨 SECURITY: email_lower key leaked').not.toMatch(/"email_lower"/);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe.skipIf(!hasDb)('integration: SAFE_PERSON_SELECT enforcement', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  // -------------------------------------------------------------------------
  // People tools
  // -------------------------------------------------------------------------

  describe('search_people — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const client = await createClient(db);
      const person = await createPerson(db, { name: 'Alice Search', email: 'alice-search@example.com' });
      await db.clientUser.create({
        data: { personId: person.id, clientId: client.id },
      });

      const { callTool } = buildToolServer(db, registerPeopleTools);
      const result = await callTool('search_people', { q: 'Alice' });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      // Confirm the safe fields are present
      const parsed = JSON.parse(result.content[0]!.text) as unknown[];
      expect(parsed.length).toBeGreaterThan(0);
      const first = parsed[0] as Record<string, unknown>;
      expect(first['id']).toBe(person.id);
      expect(first['name']).toBe('Alice Search');
      expect(first['email']).toBe('alice-search@example.com');
    });
  });

  describe('list_people — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const client = await createClient(db);
      const person = await createPerson(db, { name: 'Bob List', email: 'bob-list@example.com' });
      await db.clientUser.create({
        data: { personId: person.id, clientId: client.id },
      });

      const { callTool } = buildToolServer(db, registerPeopleTools);
      const result = await callTool('list_people', { clientId: client.id });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as Array<{ person: Record<string, unknown> }>;
      expect(parsed.length).toBeGreaterThan(0);
      // person is nested inside each ClientUser row
      const personObj = parsed[0]!.person;
      expect(personObj['id']).toBe(person.id);
      expect(personObj['name']).toBe('Bob List');
    });
  });

  describe('get_person — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const person = await createPerson(db, { name: 'Carol Get', email: 'carol-get@example.com' });

      const { callTool } = buildToolServer(db, registerPeopleTools);
      const result = await callTool('get_person', { personId: person.id });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(parsed['id']).toBe(person.id);
      expect(parsed['name']).toBe('Carol Get');
      expect(parsed['email']).toBe('carol-get@example.com');
    });

    it('response contains only safe Person fields at top level', async () => {
      const person = await createPerson(db, { name: 'Carol Safe', email: 'carol-safe@example.com' });

      const { callTool } = buildToolServer(db, registerPeopleTools);
      const result = await callTool('get_person', { personId: person.id });

      const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      // These are the ONLY person-level fields that should be present
      const personKeys = ['id', 'name', 'email', 'phone', 'isActive', 'createdAt', 'updatedAt', 'clientUsers'];
      for (const key of Object.keys(parsed)) {
        expect(personKeys, `Unexpected field "${key}" in get_person response`).toContain(key);
      }
    });
  });

  describe('create_person — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const { callTool } = buildToolServer(db, registerPeopleTools);
      const result = await callTool('create_person', {
        name: 'Dave Create',
        email: 'dave-create@example.com',
      });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as { person: Record<string, unknown> };
      expect(parsed.person['name']).toBe('Dave Create');
    });
  });

  describe('update_person — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const person = await createPerson(db, { name: 'Eve Update', email: 'eve-update@example.com' });

      const { callTool } = buildToolServer(db, registerPeopleTools);
      const result = await callTool('update_person', {
        personId: person.id,
        name: 'Eve Updated',
      });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as { person: Record<string, unknown> };
      expect(parsed.person['name']).toBe('Eve Updated');
    });
  });

  // -------------------------------------------------------------------------
  // Operator tools
  // -------------------------------------------------------------------------

  describe('list_operators — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const person = await createPerson(db, { name: 'Frank List', email: 'frank-list@example.com' });
      await db.operator.create({
        data: { personId: person.id },
      });

      const { callTool } = buildToolServer(db, registerOperatorTools);
      const result = await callTool('list_operators', {});

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as Array<Record<string, unknown>>;
      expect(parsed.length).toBeGreaterThan(0);
      // flattenOperator promotes person fields to top-level
      expect(parsed[0]!['name']).toBe('Frank List');
      expect(parsed[0]!['email']).toBe('frank-list@example.com');
    });
  });

  describe('search_operators — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const person = await createPerson(db, { name: 'Grace Search', email: 'grace-search@example.com' });
      await db.operator.create({
        data: { personId: person.id },
      });

      const { callTool } = buildToolServer(db, registerOperatorTools);
      const result = await callTool('search_operators', { q: 'Grace' });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as Array<Record<string, unknown>>;
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]!['name']).toBe('Grace Search');
    });
  });

  describe('get_operator — Person fields in response', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const person = await createPerson(db, { name: 'Hank Get', email: 'hank-get@example.com' });
      const operator = await db.operator.create({
        data: { personId: person.id },
      });

      const { callTool } = buildToolServer(db, registerOperatorTools);
      const result = await callTool('get_operator', { operatorId: operator.id });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(parsed['name']).toBe('Hank Get');
      expect(parsed['email']).toBe('hank-get@example.com');
    });
  });

  // -------------------------------------------------------------------------
  // Client tools — get_client returns Person via clientUsers
  // -------------------------------------------------------------------------

  describe('get_client — Person fields in clientUsers', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const client = await createClient(db);
      const person = await createPerson(db, { name: 'Iris Client', email: 'iris-client@example.com' });
      await db.clientUser.create({
        data: { personId: person.id, clientId: client.id },
      });

      const { callTool } = buildToolServer(db, registerClientTools);
      const result = await callTool('get_client', { clientId: client.id });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as {
        clientUsers: Array<{ person: Record<string, unknown> }>;
      };
      expect(parsed.clientUsers.length).toBeGreaterThan(0);
      expect(parsed.clientUsers[0]!.person['name']).toBe('Iris Client');
    });
  });

  // -------------------------------------------------------------------------
  // Ticket tools — get_ticket returns Person via followers
  // -------------------------------------------------------------------------

  describe('get_ticket — Person fields in followers', () => {
    it('does not expose passwordHash or emailLower', async () => {
      const client = await createClient(db);

      // Create ticket
      const ticket = await db.ticket.create({
        data: {
          clientId: client.id,
          ticketNumber: 1,
          subject: 'Test ticket for person leak check',
          status: 'NEW' as const,
          priority: 'MEDIUM' as const,
        },
      });

      // Seed a person with credential fields set
      const person = await createPerson(db, { name: 'Jack Follower', email: 'jack-follower@example.com' });

      // Add as a follower
      await db.ticketFollower.create({
        data: {
          ticketId: ticket.id,
          personId: person.id,
          followerType: 'FOLLOWER' as const,
        },
      });

      const { callTool } = buildToolServer(db, registerTicketTools);
      const result = await callTool('get_ticket', { ticketId: ticket.id });

      expect(result.isError).toBeFalsy();
      assertNoCredentialFields(result.content[0]!.text);

      const parsed = JSON.parse(result.content[0]!.text) as {
        followers: Array<{ person: Record<string, unknown> }>;
      };
      expect(parsed.followers.length).toBeGreaterThan(0);
      const followerPerson = parsed.followers[0]!.person;
      expect(followerPerson['name']).toBe('Jack Follower');
      expect(followerPerson['email']).toBe('jack-follower@example.com');
      // Safe allowlist only
      const allowedKeys = ['id', 'name', 'email', 'phone', 'isActive'];
      for (const key of Object.keys(followerPerson)) {
        expect(allowedKeys, `🚨 SECURITY: unexpected Person field "${key}" in get_ticket followers`).toContain(key);
      }
    });
  });
});
