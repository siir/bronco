-- CreateTable
CREATE TABLE "log_summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "log_count" INTEGER NOT NULL,
    "services" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "log_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "log_summaries_ticket_id_window_start_idx" ON "log_summaries"("ticket_id", "window_start");

-- CreateIndex
CREATE INDEX "log_summaries_window_start_idx" ON "log_summaries"("window_start");

-- CreateIndex
CREATE INDEX "log_summaries_created_at_idx" ON "log_summaries"("created_at");
