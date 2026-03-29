-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "ticket_id" UUID,
    "client_id" UUID,
    "prompt_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_costs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "display_name" TEXT,
    "input_cost_per_1m" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "output_cost_per_1m" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_model_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_logs_provider_model_created_at_idx" ON "ai_usage_logs"("provider", "model", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_ticket_id_idx" ON "ai_usage_logs"("ticket_id");

-- CreateIndex
CREATE INDEX "ai_usage_logs_client_id_idx" ON "ai_usage_logs"("client_id");

-- CreateIndex
CREATE INDEX "ai_usage_logs_created_at_idx" ON "ai_usage_logs"("created_at");

-- CreateIndex
CREATE INDEX "ai_model_costs_provider_idx" ON "ai_model_costs"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_costs_provider_model_key" ON "ai_model_costs"("provider", "model");
