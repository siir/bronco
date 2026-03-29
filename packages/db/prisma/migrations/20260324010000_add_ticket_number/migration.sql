-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "ticket_number" INTEGER;

-- Backfill existing tickets with sequential numbers per client
WITH numbered AS (
  SELECT id, client_id, ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY created_at, id) AS rn
  FROM tickets
)
UPDATE tickets SET ticket_number = numbered.rn
FROM numbered WHERE tickets.id = numbered.id;

-- Make column NOT NULL now that all rows are backfilled
ALTER TABLE "tickets" ALTER COLUMN "ticket_number" SET NOT NULL;

-- CreateIndex
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_ticket_number_key" UNIQUE ("client_id", "ticket_number");
