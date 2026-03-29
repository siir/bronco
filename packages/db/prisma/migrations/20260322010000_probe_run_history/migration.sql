-- AlterTable
ALTER TABLE "scheduled_probes" ADD COLUMN "retention_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "retention_max_runs" INTEGER NOT NULL DEFAULT 100;

-- CreateTable
CREATE TABLE "probe_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "probe_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "result" TEXT,
    "error" TEXT,
    "triggered_by" TEXT NOT NULL,

    CONSTRAINT "probe_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "probe_run_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "step_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "detail" TEXT,
    "error" TEXT,

    CONSTRAINT "probe_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "probe_runs_probe_id_started_at_idx" ON "probe_runs"("probe_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "probe_run_steps_run_id_step_order_idx" ON "probe_run_steps"("run_id", "step_order");

-- AddForeignKey
ALTER TABLE "probe_runs" ADD CONSTRAINT "probe_runs_probe_id_fkey" FOREIGN KEY ("probe_id") REFERENCES "scheduled_probes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "probe_run_steps" ADD CONSTRAINT "probe_run_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "probe_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
