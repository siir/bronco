-- CreateTable
CREATE TABLE "ai_model_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_type" TEXT NOT NULL,
    "scope" "override_scope" NOT NULL DEFAULT 'APP_WIDE',
    "client_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_model_configs_task_type_idx" ON "ai_model_configs"("task_type");

-- CreateIndex
CREATE INDEX "ai_model_configs_client_id_idx" ON "ai_model_configs"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_configs_task_type_scope_client_id_key" ON "ai_model_configs"("task_type", "scope", "client_id");

-- AddForeignKey
ALTER TABLE "ai_model_configs" ADD CONSTRAINT "ai_model_configs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
