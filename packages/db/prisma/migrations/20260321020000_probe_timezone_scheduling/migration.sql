-- AlterTable
ALTER TABLE "scheduled_probes" ADD COLUMN "schedule_hour" INTEGER,
ADD COLUMN "schedule_minute" INTEGER DEFAULT 0,
ADD COLUMN "schedule_days_of_week" TEXT,
ADD COLUMN "schedule_timezone" TEXT;
