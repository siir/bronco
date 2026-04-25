import { PrismaClient } from '@bronco/db';

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
