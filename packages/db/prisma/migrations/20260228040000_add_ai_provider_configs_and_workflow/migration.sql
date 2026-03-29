-- CreateTable
CREATE TABLE "ai_provider_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "base_url" TEXT,
    "encrypted_api_key" TEXT,
    "model" TEXT NOT NULL,
    "capability_level" TEXT NOT NULL DEFAULT 'STANDARD',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_provider_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_configs_name_key" ON "ai_provider_configs"("name");

-- CreateIndex
CREATE INDEX "ai_provider_configs_provider_idx" ON "ai_provider_configs"("provider");

-- CreateIndex
CREATE INDEX "ai_provider_configs_capability_level_is_active_idx" ON "ai_provider_configs"("capability_level", "is_active");

-- AlterTable
ALTER TABLE "youtube_schedule_jobs" ADD COLUMN "workflow_name" TEXT NOT NULL DEFAULT 'default';
