import { PrismaClient } from '@bronco/db';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: PrismaClient | undefined;

/**
 * Returns a PrismaClient pointed at TEST_DATABASE_URL.
 * Throws a clear error if the env var is not set.
 */
export function getTestDb(): PrismaClient {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Set it to a Postgres connection string before running integration tests.',
    );
  }

  if (!_db) {
    _db = new PrismaClient({
      datasources: {
        db: { url },
      },
    });
  }

  return _db;
}

/**
 * Truncates every non-system, non-_prisma_migrations table in the public schema.
 * Queries information_schema at runtime so it stays correct as the schema evolves.
 * RESTART IDENTITY CASCADE — foreign-key order is handled by CASCADE.
 */
export async function truncateAll(db: PrismaClient): Promise<void> {
  // Fetch all user tables in public schema except Prisma's own migration table
  const tables = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('_prisma_migrations')
    ORDER BY table_name
  `;

  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"${t.table_name}"`).join(', ');

  // Single statement — TRUNCATE supports a comma-separated list and handles FK order
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Runs prisma migrate deploy against TEST_DATABASE_URL.
 * Uses execFileSync with DATABASE_URL overridden — no shell interpolation.
 */
export function applyMigrations(): void {
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set.');
  }

  // Resolve monorepo root (packages/test-utils/src → ../../..)
  const repoRoot = path.resolve(__dirname, '..', '..', '..');

  execFileSync(
    'pnpm',
    ['--filter', '@bronco/db', 'exec', 'prisma', 'migrate', 'deploy'],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: url,
      },
    },
  );
}
