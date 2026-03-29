-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" TEXT NOT NULL,
    "source" "ticket_source" NOT NULL,
    "client_id" UUID NOT NULL,
    "route_id" UUID,
    "route_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "ticket_id" UUID,
    "error" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_run_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "step_type" TEXT NOT NULL,
    "step_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "output" TEXT,
    "error" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "duration_ms" INTEGER,

    CONSTRAINT "ingestion_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingestion_runs_client_id_started_at_idx" ON "ingestion_runs"("client_id", "started_at");

-- CreateIndex
CREATE INDEX "ingestion_runs_route_id_idx" ON "ingestion_runs"("route_id");

-- CreateIndex
CREATE INDEX "ingestion_runs_status_idx" ON "ingestion_runs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_ticket_id_key" ON "ingestion_runs"("ticket_id");

-- CreateIndex
CREATE INDEX "ingestion_run_steps_run_id_step_order_idx" ON "ingestion_run_steps"("run_id", "step_order");

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "ticket_routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_run_steps" ADD CONSTRAINT "ingestion_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
