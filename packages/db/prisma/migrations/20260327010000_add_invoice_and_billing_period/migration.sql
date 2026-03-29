-- AlterTable
-- Note: billing_markup_percent was already added by migration 20260327010000_add_billing_markup_percent_to_client
ALTER TABLE "clients" ADD COLUMN "billing_period" TEXT NOT NULL DEFAULT 'disabled';
ALTER TABLE "clients" ADD COLUMN "billing_anchor_day" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "invoice_number" INTEGER NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "total_base_cost_usd" DECIMAL(65,30) NOT NULL,
    "total_billed_cost_usd" DECIMAL(65,30) NOT NULL,
    "total_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "markup_percent" DECIMAL(65,30) NOT NULL,
    "pdf_path" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_client_id_period_start_idx" ON "invoices"("client_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_client_id_invoice_number_key" ON "invoices"("client_id", "invoice_number");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
