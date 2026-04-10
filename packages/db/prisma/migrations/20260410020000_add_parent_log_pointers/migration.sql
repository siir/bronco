ALTER TABLE "ai_usage_logs" ADD COLUMN "parent_log_id" UUID;
ALTER TABLE "ai_usage_logs" ADD COLUMN "parent_log_type" TEXT;
CREATE INDEX "ai_usage_logs_parent_log_id_idx" ON "ai_usage_logs"("parent_log_id");

ALTER TABLE "app_logs" ADD COLUMN "parent_log_id" UUID;
ALTER TABLE "app_logs" ADD COLUMN "parent_log_type" TEXT;
CREATE INDEX "app_logs_parent_log_id_idx" ON "app_logs"("parent_log_id");
