-- CreateEnum
CREATE TYPE "broadcast_status" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "google_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "added_by_user_id" UUID NOT NULL,
    "google_email" TEXT NOT NULL,
    "display_name" TEXT,
    "channel_id" TEXT,
    "channel_title" TEXT,
    "encrypted_tokens" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "token_expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_schedule_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "google_account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule_day_of_week" INTEGER NOT NULL DEFAULT 0,
    "schedule_hour" INTEGER NOT NULL DEFAULT 10,
    "schedule_minute" INTEGER NOT NULL DEFAULT 0,
    "schedule_timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "schedule_days_ahead" INTEGER NOT NULL DEFAULT 1,
    "poll_interval_hours" INTEGER NOT NULL DEFAULT 6,
    "drive_bulletin_folder_id" TEXT NOT NULL,
    "thumbnail_template_url" TEXT,
    "thumbnail_font_family" TEXT NOT NULL DEFAULT 'Arial',
    "thumbnail_font_size" INTEGER NOT NULL DEFAULT 64,
    "thumbnail_font_color" TEXT NOT NULL DEFAULT '#FFFFFF',
    "thumbnail_text_x" INTEGER NOT NULL DEFAULT 80,
    "thumbnail_text_y" INTEGER NOT NULL DEFAULT 400,
    "thumbnail_text_max_width" INTEGER NOT NULL DEFAULT 1120,
    "privacy_status" TEXT NOT NULL DEFAULT 'public',
    "enable_dvr" BOOLEAN NOT NULL DEFAULT true,
    "enable_auto_start" BOOLEAN NOT NULL DEFAULT true,
    "enable_auto_stop" BOOLEAN NOT NULL DEFAULT true,
    "stream_resolution" TEXT NOT NULL DEFAULT '1080p',
    "stream_frame_rate" TEXT NOT NULL DEFAULT '30fps',
    "ingestion_type" TEXT NOT NULL DEFAULT 'rtmp',
    "stream_title_template" TEXT NOT NULL DEFAULT 'Worship Service - {date}',
    "stream_description_template" TEXT NOT NULL DEFAULT E'Join us for worship!\n\nTheme: {theme}\n\nBulletin: {bulletinLink}',
    "last_scheduled_date" TEXT,
    "last_run_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "youtube_schedule_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_broadcast_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "google_account_id" UUID NOT NULL,
    "broadcast_id" TEXT,
    "stream_id" TEXT,
    "stream_key" TEXT,
    "watch_url" TEXT,
    "service_date" TEXT NOT NULL,
    "theme" TEXT,
    "title" TEXT,
    "bulletin_pdf_link" TEXT,
    "status" "broadcast_status" NOT NULL DEFAULT 'SCHEDULED',
    "error" TEXT,
    "pipeline_duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_broadcast_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_accounts_google_email_key" ON "google_accounts"("google_email");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_schedule_jobs_google_account_id_name_key" ON "youtube_schedule_jobs"("google_account_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_broadcast_logs_job_id_service_date_key" ON "youtube_broadcast_logs"("job_id", "service_date");

-- CreateIndex
CREATE INDEX "youtube_broadcast_logs_google_account_id_idx" ON "youtube_broadcast_logs"("google_account_id");

-- CreateIndex
CREATE INDEX "youtube_broadcast_logs_service_date_idx" ON "youtube_broadcast_logs"("service_date");

-- AddForeignKey
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_schedule_jobs" ADD CONSTRAINT "youtube_schedule_jobs_google_account_id_fkey" FOREIGN KEY ("google_account_id") REFERENCES "google_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_broadcast_logs" ADD CONSTRAINT "youtube_broadcast_logs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "youtube_schedule_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_broadcast_logs" ADD CONSTRAINT "youtube_broadcast_logs_google_account_id_fkey" FOREIGN KEY ("google_account_id") REFERENCES "google_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
