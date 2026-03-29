-- CreateEnum
CREATE TYPE "system_analysis_status" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'REJECTED');

-- CreateTable
CREATE TABLE "system_analyses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "status" "system_analysis_status" NOT NULL DEFAULT 'PENDING',
    "analysis" TEXT NOT NULL,
    "suggestions" TEXT NOT NULL,
    "rejection_reason" TEXT,
    "ai_model" TEXT,
    "ai_provider" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_analyses_status_idx" ON "system_analyses"("status");

-- CreateIndex
CREATE INDEX "system_analyses_client_id_idx" ON "system_analyses"("client_id");

-- CreateIndex
CREATE INDEX "system_analyses_ticket_id_idx" ON "system_analyses"("ticket_id");

-- CreateIndex
CREATE INDEX "system_analyses_created_at_idx" ON "system_analyses"("created_at");

-- AddForeignKey
ALTER TABLE "system_analyses" ADD CONSTRAINT "system_analyses_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_analyses" ADD CONSTRAINT "system_analyses_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
