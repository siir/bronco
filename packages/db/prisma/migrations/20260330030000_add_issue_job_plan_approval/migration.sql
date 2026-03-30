-- AlterEnum
ALTER TYPE "issue_job_status" ADD VALUE 'PLANNING';
ALTER TYPE "issue_job_status" ADD VALUE 'AWAITING_APPROVAL';

-- AlterTable
ALTER TABLE "issue_jobs" ADD COLUMN "plan" JSONB,
ADD COLUMN "plan_revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "plan_feedback" TEXT,
ADD COLUMN "approved_at" TIMESTAMP(3),
ADD COLUMN "approved_by" TEXT;
