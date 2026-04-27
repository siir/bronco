import { PrismaClient } from '@bronco/db';
import { encrypt } from '@bronco/shared-utils';

// ---------------------------------------------------------------------------
// Re-usable payload types derived from the Prisma client
// ---------------------------------------------------------------------------

/** The default shape returned when querying a Client row (no relations). */
export type ClientRow = Awaited<ReturnType<PrismaClient['client']['create']>>;

/** The default shape returned when querying a Ticket row (no relations). */
export type TicketRow = Awaited<ReturnType<PrismaClient['ticket']['create']>>;

// ---------------------------------------------------------------------------
// Client fixtures
// ---------------------------------------------------------------------------

export interface CreateClientOverrides {
  name?: string;
  shortCode?: string;
  isActive?: boolean;
}

/**
 * Creates a Client row with sensible test defaults.
 * Override any field via the second argument.
 */
export async function createClient(
  db: PrismaClient,
  overrides: CreateClientOverrides = {},
): Promise<ClientRow> {
  const suffix = crypto.randomUUID().slice(0, 8);
  return db.client.create({
    data: {
      name: overrides.name ?? `Test Client ${suffix}`,
      shortCode: overrides.shortCode ?? `TC-${suffix}`,
      isActive: overrides.isActive ?? true,
    },
  });
}

// ---------------------------------------------------------------------------
// Ticket fixtures
// ---------------------------------------------------------------------------

export interface CreateTicketOverrides {
  subject?: string;
  description?: string;
}

/**
 * Creates a Ticket row linked to the given clientId.
 * Computes the next ticketNumber by querying the max existing number for the client.
 */
export async function createTicket(
  db: PrismaClient,
  params: { clientId: string } & CreateTicketOverrides,
): Promise<TicketRow> {
  const { clientId, ...overrides } = params;

  // Compute next ticket number for this client (mirrors ingestion-engine logic)
  const last = await db.ticket.findFirst({
    where: { clientId },
    orderBy: { ticketNumber: 'desc' },
    select: { ticketNumber: true },
  });
  const ticketNumber = (last?.ticketNumber ?? 0) + 1;

  return db.ticket.create({
    data: {
      clientId,
      ticketNumber,
      subject: overrides.subject ?? `Test Ticket ${crypto.randomUUID().slice(0, 8)}`,
      description: overrides.description,
      // Using string literals — these match Prisma enum values in schema.prisma
      status: 'NEW' as const,
      priority: 'MEDIUM' as const,
    },
  });
}

// ---------------------------------------------------------------------------
// System fixtures
// ---------------------------------------------------------------------------

/** The default shape returned when creating a System row. */
export type SystemRow = Awaited<ReturnType<PrismaClient['system']['create']>>;

export interface CreateSystemOverrides {
  name?: string;
  dbEngine?: string;
  host?: string;
  port?: number;
  connectionString?: string | null;
  instanceName?: string | null;
  defaultDatabase?: string | null;
  authMethod?: string;
  username?: string | null;
  /** Plain-text password — will be encrypted with encryptionKey before storing. */
  password?: string | null;
  useTls?: boolean;
  trustServerCert?: boolean;
  connectionTimeout?: number;
  requestTimeout?: number;
  maxPoolSize?: number;
  isActive?: boolean;
  environment?: string;
}

/**
 * Creates a System row linked to the given clientId.
 * Pass a plain-text `password` and `encryptionKey` — the fixture encrypts it
 * before writing, mirroring how the application stores credentials.
 *
 * Set `isActive: false` to create an inactive system.
 */
export async function createSystem(
  db: PrismaClient,
  params: { clientId: string; encryptionKey?: string } & CreateSystemOverrides,
): Promise<SystemRow> {
  const { clientId, encryptionKey, ...overrides } = params;
  const suffix = crypto.randomUUID().slice(0, 8);

  let encryptedPassword: string | null = null;
  const plainPassword = overrides.password ?? 'testpassword';
  if (plainPassword && encryptionKey) {
    encryptedPassword = encrypt(plainPassword, encryptionKey);
  }

  return db.system.create({
    data: {
      clientId,
      name: overrides.name ?? `Test System ${suffix}`,
      dbEngine: (overrides.dbEngine ?? 'MSSQL') as never,
      host: overrides.host ?? 'sql.test.local',
      port: overrides.port ?? 1433,
      // Use explicit `in` check so callers can pass `null` to clear optional fields.
      // The `??` operator treats null as nullish and would fall back to the default.
      connectionString: 'connectionString' in overrides ? (overrides.connectionString ?? null) : null,
      instanceName: 'instanceName' in overrides ? (overrides.instanceName ?? null) : null,
      defaultDatabase: 'defaultDatabase' in overrides ? overrides.defaultDatabase : 'TestDb',
      authMethod: (overrides.authMethod ?? 'SQL_AUTH') as never,
      username: 'username' in overrides ? overrides.username : 'sa',
      encryptedPassword,
      useTls: overrides.useTls ?? false,
      trustServerCert: overrides.trustServerCert ?? true,
      connectionTimeout: overrides.connectionTimeout ?? 15000,
      requestTimeout: overrides.requestTimeout ?? 30000,
      maxPoolSize: overrides.maxPoolSize ?? 5,
      isActive: overrides.isActive ?? true,
      environment: (overrides.environment ?? 'PRODUCTION') as never,
    },
  });
}

// ---------------------------------------------------------------------------
// AiModelConfig fixtures
// ---------------------------------------------------------------------------

/** The default shape returned when creating an AiModelConfig row. */
export type AiModelConfigRow = Awaited<ReturnType<PrismaClient['aiModelConfig']['create']>>;

export interface CreateAiModelConfigOverrides {
  taskType?: string;
  scope?: 'APP_WIDE' | 'CLIENT';
  clientId?: string | null;
  provider?: string;
  model?: string;
  maxTokens?: number | null;
  isActive?: boolean;
}

/**
 * Creates an AiModelConfig row with sensible test defaults.
 * Defaults to APP_WIDE scope with no clientId.
 */
export async function createAiModelConfig(
  db: PrismaClient,
  overrides: CreateAiModelConfigOverrides = {},
): Promise<AiModelConfigRow> {
  return db.aiModelConfig.create({
    data: {
      taskType: overrides.taskType ?? 'DEEP_ANALYSIS',
      // Prisma enum — cast to never to bypass module augmentation gap in @bronco/db re-exports
      scope: (overrides.scope ?? 'APP_WIDE') as never,
      clientId: overrides.clientId ?? null,
      provider: overrides.provider ?? 'CLAUDE',
      model: overrides.model ?? 'claude-sonnet-4-6',
      maxTokens: overrides.maxTokens ?? null,
      isActive: overrides.isActive ?? true,
    },
  });
}

// ---------------------------------------------------------------------------
// ClientMemory fixtures
// ---------------------------------------------------------------------------

/** The default shape returned when creating a ClientMemory row. */
export type ClientMemoryRow = Awaited<ReturnType<PrismaClient['clientMemory']['create']>>;

export interface CreateClientMemoryOverrides {
  title?: string;
  memoryType?: string;
  category?: string | null;
  tags?: string[];
  content?: string;
  isActive?: boolean;
  sortOrder?: number;
  source?: string;
}

/**
 * Creates a ClientMemory row for the given clientId with sensible test defaults.
 */
export async function createClientMemory(
  db: PrismaClient,
  params: { clientId: string } & CreateClientMemoryOverrides,
): Promise<ClientMemoryRow> {
  const { clientId, ...overrides } = params;
  const suffix = crypto.randomUUID().slice(0, 8);
  return db.clientMemory.create({
    data: {
      clientId,
      title: overrides.title ?? `Test Memory ${suffix}`,
      memoryType: overrides.memoryType ?? 'CONTEXT',
      category: (overrides.category ?? null) as never,
      tags: overrides.tags ?? [],
      content: overrides.content ?? `Test memory content ${suffix}`,
      isActive: overrides.isActive ?? true,
      sortOrder: overrides.sortOrder ?? 0,
      source: overrides.source ?? 'MANUAL',
    },
  });
}

// ---------------------------------------------------------------------------
// Person fixtures
// ---------------------------------------------------------------------------

/** The default shape returned when creating a Person row. */
export type PersonRow = Awaited<ReturnType<PrismaClient['person']['create']>>;

export interface CreatePersonOverrides {
  name?: string;
  email?: string;
  emailLower?: string;
  phone?: string | null;
  /** Seeded with a sentinel value so leaks are unmistakable in assertions. */
  passwordHash?: string | null;
  isActive?: boolean;
}

/**
 * Creates a Person row with sensible test defaults.
 * Seeds `passwordHash: 'TEST_HASH_NEVER_LEAK'` by default so any credential
 * leak in tool-response payloads is immediately visible in assertions.
 */
export async function createPerson(
  db: PrismaClient,
  overrides: CreatePersonOverrides = {},
): Promise<PersonRow> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const email = overrides.email ?? `testperson-${suffix}@example.com`;
  const emailLower = overrides.emailLower ?? email.toLowerCase();
  return db.person.create({
    data: {
      name: overrides.name ?? `Test Person ${suffix}`,
      email,
      emailLower,
      phone: overrides.phone !== undefined ? overrides.phone : null,
      passwordHash: overrides.passwordHash !== undefined ? overrides.passwordHash : 'TEST_HASH_NEVER_LEAK',
      isActive: overrides.isActive ?? true,
    },
  });
}
