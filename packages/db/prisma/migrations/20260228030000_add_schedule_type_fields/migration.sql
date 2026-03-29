-- AlterTable
ALTER TABLE "youtube_schedule_jobs" ADD COLUMN "schedule_type" TEXT NOT NULL DEFAULT 'WEEKLY';
ALTER TABLE "youtube_schedule_jobs" ADD COLUMN "schedule_frequency" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "youtube_schedule_jobs" ADD COLUMN "schedule_one_time_date" TEXT;
ALTER TABLE "youtube_schedule_jobs" ADD COLUMN "schedule_day_of_month" INTEGER NOT NULL DEFAULT 1;
