-- AlterEnum
ALTER TYPE "ticket_status" ADD VALUE 'NEW';

-- Backfill: OPEN tickets with no completed AI_ANALYSIS event → NEW
UPDATE tickets
SET status = 'NEW'
WHERE status = 'OPEN'
  AND NOT EXISTS (
    SELECT 1 FROM ticket_events
    WHERE ticket_events.ticket_id = tickets.id
      AND event_type = 'AI_ANALYSIS'
  );
