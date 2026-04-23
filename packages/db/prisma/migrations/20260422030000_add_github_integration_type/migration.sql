-- AlterEnum
-- NOTE: Postgres requires new enum values to be committed before they can be used.
-- The second migration (20260422030100) alters the ClientIntegration table shape
-- and is split out so this ALTER TYPE commits in its own transaction first.
ALTER TYPE "integration_type" ADD VALUE 'GITHUB';
