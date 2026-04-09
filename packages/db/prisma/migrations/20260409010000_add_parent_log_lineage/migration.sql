-- AlterTable
ALTER TABLE "app_logs" ADD COLUMN "parent_log_id" UUID,
ADD COLUMN "parent_log_type" TEXT;

-- AlterTable
ALTER TABLE "ai_usage_logs" ADD COLUMN "parent_log_id" UUID,
ADD COLUMN "parent_log_type" TEXT;

-- CreateIndex
CREATE INDEX "app_logs_parent_log_id_idx" ON "app_logs"("parent_log_id");

-- CreateIndex
CREATE INDEX "ai_usage_logs_parent_log_id_idx" ON "ai_usage_logs"("parent_log_id");
