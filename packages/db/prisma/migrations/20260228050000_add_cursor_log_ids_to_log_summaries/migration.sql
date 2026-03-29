-- AlterTable
ALTER TABLE "log_summaries" ADD COLUMN "cursor_log_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
