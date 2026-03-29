-- AlterTable
ALTER TABLE "ai_provider_configs" ADD COLUMN "enabled_apps" TEXT[] NOT NULL DEFAULT '{}';
