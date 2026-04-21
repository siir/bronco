import type { PrismaClient } from '@bronco/db';

/**
 * Prisma transaction client type derived from `$transaction`'s callback arg.
 * Re-declared here to avoid importing internal `@prisma/client/runtime` types.
 */
export type PrismaTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Run `fn` inside a transaction holding a Postgres advisory lock keyed on the
 * ticket ID. The lock is acquired via `pg_advisory_xact_lock(hashtext($1))`
 * and auto-released at transaction boundary — commit or rollback both free it.
 *
 * Use this to serialize read-modify-write on `knowledgeDoc` so concurrent
 * `kd_update_section` / `kd_add_subsection` calls from parallel sub-tasks
 * don't clobber each other.
 */
export async function withTicketLock<T>(
  db: PrismaClient,
  ticketId: string,
  fn: (tx: PrismaTx) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ticketId}))`;
    return fn(tx);
  });
}
