/**
 * Integration tests for systems-loader.ts
 *
 * Requires a real PostgreSQL DB via TEST_DATABASE_URL.
 * ENCRYPTION_KEY is set to a fixed 64-hex-char test value in beforeAll.
 *
 * Coverage:
 *  - loadSystemsFromDb returns only isActive=true rows
 *  - Inactive systems are excluded
 *  - All SystemConfigEntry fields are mapped correctly
 *  - Password is decrypted correctly when encryptedPassword is present
 *  - Null password when encryptedPassword is null
 *  - Decryption failure (wrong key) logs a warning and returns null password
 *  - Empty DB returns empty array
 *  - Multiple systems across different clients are all returned
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getTestDb, truncateAll, createClient, createSystem } from '@bronco/test-utils';
import { decrypt } from '@bronco/shared-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fixed 256-bit (64 hex char) test encryption key.
 * Never use this value outside of test code.
 */
const TEST_ENCRYPTION_KEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

const db = getTestDb();

beforeAll(async () => {
  // Set ENCRYPTION_KEY in process.env so any code path reading it uses the test value
  process.env['ENCRYPTION_KEY'] = TEST_ENCRYPTION_KEY;
  await truncateAll(db);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await db.$disconnect();
  delete process.env['ENCRYPTION_KEY'];
});

// ---------------------------------------------------------------------------
// Import under test (after env vars are set)
// ---------------------------------------------------------------------------

const { loadSystemsFromDb } = await import('./systems-loader.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadSystemsFromDb', () => {
  // -------------------------------------------------------------------------
  // Empty DB
  // -------------------------------------------------------------------------

  it('returns empty array when no active systems exist', async () => {
    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Active vs inactive filtering
  // -------------------------------------------------------------------------

  it('returns only isActive=true systems', async () => {
    const client = await createClient(db);
    await createSystem(db, {
      clientId: client.id,
      name: 'Active System',
      isActive: true,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await createSystem(db, {
      clientId: client.id,
      name: 'Inactive System',
      isActive: false,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Active System');
  });

  it('returns empty array when all systems are inactive', async () => {
    const client = await createClient(db);
    await createSystem(db, { clientId: client.id, name: 'Inactive', isActive: false });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Field mapping
  // -------------------------------------------------------------------------

  it('maps all SystemConfigEntry fields correctly', async () => {
    const client = await createClient(db, { name: 'Field Test Client', shortCode: 'FTC' });
    await createSystem(db, {
      clientId: client.id,
      name: 'Field Test System',
      dbEngine: 'AZURE_SQL_MI',
      host: 'my-instance.database.windows.net',
      port: 3342,
      defaultDatabase: 'AppDb',
      authMethod: 'SQL_AUTH',
      username: 'adminuser',
      password: 'p@ssw0rd!',
      encryptionKey: TEST_ENCRYPTION_KEY,
      useTls: true,
      trustServerCert: false,
      connectionTimeout: 20000,
      requestTimeout: 45000,
      maxPoolSize: 8,
      environment: 'STAGING',
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result).toHaveLength(1);

    const entry = result[0]!;
    expect(entry.clientId).toBe(client.id);
    expect(entry.clientName).toBe('Field Test Client');
    expect(entry.clientCode).toBe('FTC');
    expect(entry.name).toBe('Field Test System');
    expect(entry.dbEngine).toBe('AZURE_SQL_MI');
    expect(entry.host).toBe('my-instance.database.windows.net');
    expect(entry.port).toBe(3342);
    expect(entry.defaultDatabase).toBe('AppDb');
    expect(entry.authMethod).toBe('SQL_AUTH');
    expect(entry.username).toBe('adminuser');
    expect(entry.useTls).toBe(true);
    expect(entry.trustServerCert).toBe(false);
    expect(entry.connectionTimeout).toBe(20000);
    expect(entry.requestTimeout).toBe(45000);
    expect(entry.maxPoolSize).toBe(8);
    expect(entry.environment).toBe('STAGING');
  });

  it('entry.id matches the database row id', async () => {
    const client = await createClient(db);
    const system = await createSystem(db, {
      clientId: client.id,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result[0]!.id).toBe(system.id);
  });

  it('optional fields default to null when not set', async () => {
    const client = await createClient(db);
    await createSystem(db, {
      clientId: client.id,
      instanceName: null,
      connectionString: null,
      defaultDatabase: null,
      username: null,
      password: null,
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    const entry = result[0]!;
    expect(entry.instanceName).toBeNull();
    expect(entry.connectionString).toBeNull();
    expect(entry.defaultDatabase).toBeNull();
    expect(entry.username).toBeNull();
    expect(entry.password).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Password decryption
  // -------------------------------------------------------------------------

  it('decrypts password correctly', async () => {
    const client = await createClient(db);
    await createSystem(db, {
      clientId: client.id,
      password: 'SuperSecretPassword!',
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result[0]!.password).toBe('SuperSecretPassword!');
  });

  it('returns null password when encryptedPassword is null', async () => {
    const client = await createClient(db);
    // createSystem with no encryptionKey means no encryption → null stored
    await createSystem(db, {
      clientId: client.id,
      password: null,
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result[0]!.password).toBeNull();
  });

  it('🚨 SECURITY: decrypted password matches original plaintext (round-trip integrity)', async () => {
    const client = await createClient(db);
    const plaintext = 'my-db-password-123';
    await createSystem(db, {
      clientId: client.id,
      password: plaintext,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    // The loader decrypts the password — it must equal the original plaintext
    expect(result[0]!.password).toBe(plaintext);
  });

  it('returns null password and does not throw when decryption fails (wrong key)', async () => {
    const client = await createClient(db);
    await createSystem(db, {
      clientId: client.id,
      password: 'secret-value',
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    // Use a different wrong key — should log warning and return null password
    const wrongKey = 'b'.repeat(64);
    const result = await loadSystemsFromDb(db, wrongKey);
    // Should still return the system row but with null password
    expect(result).toHaveLength(1);
    expect(result[0]!.password).toBeNull();
  });

  it('🚨 SECURITY: password stored in DB is encrypted (not plaintext)', async () => {
    const client = await createClient(db);
    const plaintext = 'never-store-plain';
    await createSystem(db, {
      clientId: client.id,
      password: plaintext,
      encryptionKey: TEST_ENCRYPTION_KEY,
    });

    // Read directly from DB — encryptedPassword must NOT equal plaintext
    const row = await db.system.findFirst({
      where: { clientId: client.id },
      select: { encryptedPassword: true },
    });
    expect(row).not.toBeNull();
    expect(row!.encryptedPassword).not.toBeNull();
    expect(row!.encryptedPassword).not.toBe(plaintext);
    // Should be decryptable back to plaintext
    const decrypted = decrypt(row!.encryptedPassword!, TEST_ENCRYPTION_KEY);
    expect(decrypted).toBe(plaintext);
  });

  // -------------------------------------------------------------------------
  // Multiple systems / clients
  // -------------------------------------------------------------------------

  it('returns all active systems across multiple clients', async () => {
    const clientA = await createClient(db, { shortCode: 'CA' });
    const clientB = await createClient(db, { shortCode: 'CB' });

    await createSystem(db, {
      clientId: clientA.id,
      name: 'System A1',
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await createSystem(db, {
      clientId: clientA.id,
      name: 'System A2',
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await createSystem(db, {
      clientId: clientB.id,
      name: 'System B1',
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    // One inactive
    await createSystem(db, {
      clientId: clientB.id,
      name: 'System B2 Inactive',
      isActive: false,
    });

    const result = await loadSystemsFromDb(db, TEST_ENCRYPTION_KEY);
    expect(result).toHaveLength(3);
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(['System A1', 'System A2', 'System B1']);
  });
});
