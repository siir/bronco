-- AlterTable: Add analysis status tracking fields to tickets
-- Default existing tickets to COMPLETED (they've been through the old pipeline).
ALTER TABLE "tickets" ADD COLUMN "analysis_status" TEXT NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE "tickets" ADD COLUMN "analysis_error" TEXT;
ALTER TABLE "tickets" ADD COLUMN "last_analyzed_at" TIMESTAMP(3);

-- Switch the DB default to PENDING so new rows match the Prisma schema default.
ALTER TABLE "tickets" ALTER COLUMN "analysis_status" SET DEFAULT 'PENDING';
