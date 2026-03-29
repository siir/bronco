-- Drop unique constraint on ticket_id to allow re-ingestion of the same ticket.
-- A ticket can now have multiple ingestion run records.
DROP INDEX IF EXISTS "ingestion_runs_ticket_id_key";

-- Add a non-unique index to preserve query performance on ticket_id lookups.
CREATE INDEX "ingestion_runs_ticket_id_idx" ON "ingestion_runs"("ticket_id");
