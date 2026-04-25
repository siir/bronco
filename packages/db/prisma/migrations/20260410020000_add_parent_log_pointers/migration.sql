-- Idempotent version of this migration: the preceding migration
-- 20260409010000_add_parent_log_lineage added the same columns and indexes
-- to both ai_usage_logs and app_logs (same feature, issue #187). On a fresh
-- database this migration was a duplicate and failed with
-- "column already exists" (error 42701). Production already has both
-- migrations marked applied — Prisma does not re-verify checksums on
-- already-applied migrations, so the drift here is a no-op for existing
-- deploys. Only fresh deploys (dev resets, test DBs, new environments)
-- benefit from the IF NOT EXISTS guards below.

ALTER TABLE "ai_usage_logs" ADD COLUMN IF NOT EXISTS "parent_log_id" UUID;
ALTER TABLE "ai_usage_logs" ADD COLUMN IF NOT EXISTS "parent_log_type" TEXT;
CREATE INDEX IF NOT EXISTS "ai_usage_logs_parent_log_id_idx" ON "ai_usage_logs"("parent_log_id");

ALTER TABLE "app_logs" ADD COLUMN IF NOT EXISTS "parent_log_id" UUID;
ALTER TABLE "app_logs" ADD COLUMN IF NOT EXISTS "parent_log_type" TEXT;
CREATE INDEX IF NOT EXISTS "app_logs_parent_log_id_idx" ON "app_logs"("parent_log_id");
