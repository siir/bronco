import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from './db.js';
import { createClient, createTicket } from './fixtures.js';
import type { PrismaClient } from '@bronco/db';

const hasDb = Boolean(process.env['TEST_DATABASE_URL']);

describe.skipIf(!hasDb)('integration: db round-trip', () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = getTestDb();
    await truncateAll(db);
  });

  beforeEach(async () => {
    await truncateAll(db);
  });

  it('creates a Client and a Ticket, then re-queries with fidelity', async () => {
    const client = await createClient(db, { name: 'Acme Corp' });
    const ticket = await createTicket(db, {
      clientId: client.id,
      subject: 'Slow query on reports table',
    });

    const fetched = await db.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
    });

    expect(fetched.id).toBe(ticket.id);
    expect(fetched.clientId).toBe(client.id);
    expect(fetched.subject).toBe('Slow query on reports table');
    expect(fetched.ticketNumber).toBe(1);
  });
});
