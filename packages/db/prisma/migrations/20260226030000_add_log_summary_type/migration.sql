-- CreateEnum
CREATE TYPE "log_summary_type" AS ENUM ('TICKET', 'ORPHAN', 'SERVICE', 'UNCATEGORIZED');

-- AlterTable
ALTER TABLE "log_summaries" ADD COLUMN "summary_type" "log_summary_type" NOT NULL DEFAULT 'SERVICE';

-- Backfill: existing summaries with a ticket_id are TICKET type
UPDATE "log_summaries" SET "summary_type" = 'TICKET' WHERE "ticket_id" IS NOT NULL;

-- Backfill: existing summaries without a ticket_id are ORPHAN type (pre-migration default was SERVICE)
UPDATE "log_summaries" SET "summary_type" = 'ORPHAN' WHERE "ticket_id" IS NULL;

-- CreateIndex
CREATE INDEX "log_summaries_summary_type_window_start_idx" ON "log_summaries"("summary_type", "window_start");
