-- CreateTable
CREATE TABLE "email_processing_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "from_name" TEXT,
    "subject" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "classification" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processed',
    "client_id" UUID,
    "ticket_id" UUID,
    "error_message" TEXT,
    "processing_ms" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_processing_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_processing_logs_message_id_key" ON "email_processing_logs"("message_id");

-- CreateIndex
CREATE INDEX "email_processing_logs_status_idx" ON "email_processing_logs"("status");

-- CreateIndex
CREATE INDEX "email_processing_logs_classification_idx" ON "email_processing_logs"("classification");

-- CreateIndex
CREATE INDEX "email_processing_logs_client_id_created_at_idx" ON "email_processing_logs"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "email_processing_logs_created_at_idx" ON "email_processing_logs"("created_at");

-- AddForeignKey
ALTER TABLE "email_processing_logs" ADD CONSTRAINT "email_processing_logs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_processing_logs" ADD CONSTRAINT "email_processing_logs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
