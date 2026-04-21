-- AlterTable
ALTER TABLE "tool_requests"
  ADD COLUMN "suggested_duplicate_of_id" UUID,
  ADD COLUMN "suggested_duplicate_reason" TEXT,
  ADD COLUMN "suggested_improves_existing" TEXT,
  ADD COLUMN "suggested_improves_reason" TEXT,
  ADD COLUMN "dedupe_analysis_at" TIMESTAMP(3);
