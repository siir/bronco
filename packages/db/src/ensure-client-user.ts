import type { PrismaClient } from '@prisma/client';

/**
 * Legacy helper that auto-provisioned a CLIENT-role `User` account for an
 * inbound requester. The unified auth model drops the User table and the
 * CLIENT role entirely — access is now explicit (Operator + ClientUser
 * extension records), never implicit from a ticket submission.
 *
 * Kept as a no-op shim so existing call sites stay compiling. Wave 2A
 * removes the callers.
 *
 * TODO: #219 Wave 2A — delete this helper and its call sites.
 */
export async function ensureClientUser(
  _db: PrismaClient,
  _contact: { email: string; name: string; clientId: string },
): Promise<void> {
  return;
}
