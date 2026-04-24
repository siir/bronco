/**
 * Shared Prisma select projections for MCP platform tools.
 *
 * SAFE_PERSON_SELECT — explicit allowlist for Person fields returned to MCP callers.
 * Deliberately excludes sensitive fields such as passwordHash, emailLower, and any
 * future credential-adjacent columns.  Import and reuse this constant in every tool
 * that joins or queries a Person so the allowlist is maintained in one place.
 */
export const SAFE_PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
} as const;
