-- CreateEnum: AnalysisStatus for ticket.analysis_status column
-- Converts the existing TEXT column to a proper PostgreSQL enum for DB-level validation.

CREATE TYPE "analysis_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED');

-- Drop the TEXT default before changing the type (Postgres cannot cast it automatically)
ALTER TABLE "tickets" ALTER COLUMN "analysis_status" DROP DEFAULT;

-- AlterTable: convert analysis_status from TEXT to the new enum type
ALTER TABLE "tickets"
  ALTER COLUMN "analysis_status" TYPE "analysis_status" USING "analysis_status"::"analysis_status";

-- Restore the default using the enum value
ALTER TABLE "tickets" ALTER COLUMN "analysis_status" SET DEFAULT 'PENDING'::"analysis_status";
