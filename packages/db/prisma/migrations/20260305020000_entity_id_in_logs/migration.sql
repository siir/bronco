-- Rename ticket_id → entity_id and add entity_type in app_logs
-- This allows the column to reference either a ticket or an operational task
-- without causing spurious FK-style joins against the tickets table.

ALTER TABLE "app_logs" RENAME COLUMN "ticket_id" TO "entity_id";
ALTER TABLE "app_logs" ADD COLUMN "entity_type" TEXT;

-- Back-fill existing rows: all historical entries came from ticket-scoped services
-- so they are all 'ticket' entities.
-- Rows with NULL entity_id are global/service-level logs with no entity association;
-- they correctly remain NULL entity_type and do not need a default.
UPDATE "app_logs" SET "entity_type" = 'ticket' WHERE "entity_id" IS NOT NULL;

-- Drop the old single-column index and replace with a composite one.
DROP INDEX IF EXISTS "app_logs_ticket_id_idx";
CREATE INDEX "app_logs_entity_id_entity_type_idx" ON "app_logs"("entity_id", "entity_type");

-- Enforce that entity_id and entity_type are either both NULL (global logs) or both non-NULL.
ALTER TABLE "app_logs" ADD CONSTRAINT "app_logs_entity_consistency_check"
  CHECK (("entity_id" IS NULL) = ("entity_type" IS NULL));

-- Rename ticket_id → entity_id and add entity_type in ai_usage_logs

ALTER TABLE "ai_usage_logs" RENAME COLUMN "ticket_id" TO "entity_id";
ALTER TABLE "ai_usage_logs" ADD COLUMN "entity_type" TEXT;

-- Back-fill existing rows.
-- Rows with NULL entity_id are global/service-level logs with no entity association;
-- they correctly remain NULL entity_type and do not need a default.
UPDATE "ai_usage_logs" SET "entity_type" = 'ticket' WHERE "entity_id" IS NOT NULL;

-- Drop the old single-column index and replace with a composite one.
DROP INDEX IF EXISTS "ai_usage_logs_ticket_id_idx";
CREATE INDEX "ai_usage_logs_entity_id_entity_type_idx" ON "ai_usage_logs"("entity_id", "entity_type");

-- Enforce that entity_id and entity_type are either both NULL (global logs) or both non-NULL.
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_entity_consistency_check"
  CHECK (("entity_id" IS NULL) = ("entity_type" IS NULL));
