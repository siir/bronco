import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';

/**
 * Ensure a CLIENT-role User account exists for the given contact.
 * Uses an atomic upsert so concurrent calls are safe.
 * The account is created with a bcrypt hash of a random secret — the user
 * will need an invitation / password-reset flow to actually log in.
 */
export async function ensureClientUser(
  db: PrismaClient,
  contact: { email: string; name: string; clientId: string },
): Promise<void> {
  const email = contact.email.toLowerCase();

  // Valid bcrypt hash of a random secret — unusable without password-reset,
  // but won't cause bcrypt.compare() to throw if the account is ever checked.
  const unusableHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);

  await db.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash: unusableHash,
      name: contact.name,
      role: 'CLIENT',
      clientId: contact.clientId,
    },
    update: {},
  });
}
