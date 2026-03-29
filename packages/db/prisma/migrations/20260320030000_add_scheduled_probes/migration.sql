-- CreateTable
CREATE TABLE "scheduled_probes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tool_name" TEXT NOT NULL,
    "tool_params" JSONB NOT NULL DEFAULT '{}',
    "cron_expression" TEXT NOT NULL,
    "category" "ticket_category",
    "action" TEXT NOT NULL DEFAULT 'create_ticket',
    "action_config" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "last_run_status" TEXT,
    "last_run_result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_probes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_probes_client_id_is_active_idx" ON "scheduled_probes"("client_id", "is_active");

-- AddForeignKey
ALTER TABLE "scheduled_probes" ADD CONSTRAINT "scheduled_probes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_probes" ADD CONSTRAINT "scheduled_probes_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "client_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
