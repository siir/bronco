-- CreateEnum
CREATE TYPE "log_level" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "app_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "level" "log_level" NOT NULL,
    "service" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "ticket_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_logs_service_created_at_idx" ON "app_logs"("service", "created_at");

-- CreateIndex
CREATE INDEX "app_logs_level_created_at_idx" ON "app_logs"("level", "created_at");

-- CreateIndex
CREATE INDEX "app_logs_ticket_id_idx" ON "app_logs"("ticket_id");

-- CreateIndex
CREATE INDEX "app_logs_created_at_idx" ON "app_logs"("created_at");
