-- AlterEnum
-- NOTE: Postgres requires new enum values to be committed before they can be used.
-- The backfill UPDATE that relies on 'NEW' lives in 20260422000500_backfill_new_ticket_status
-- so that it runs in a separate transaction after this one commits.
ALTER TYPE "ticket_status" ADD VALUE 'NEW';
