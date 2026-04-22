-- Backfill: OPEN tickets with no AI_ANALYSIS event recorded (i.e., pre-analysis) → NEW
-- Runs in its own transaction AFTER the ALTER TYPE in 20260422000000 has committed;
-- splitting is required because Postgres rejects new enum values used in the same
-- transaction that added them (error 55P04 — "unsafe use of new value").
UPDATE tickets
SET status = 'NEW'
WHERE status = 'OPEN'
  AND NOT EXISTS (
    SELECT 1 FROM ticket_events
    WHERE ticket_events.ticket_id = tickets.id
      AND event_type = 'AI_ANALYSIS'
  );
