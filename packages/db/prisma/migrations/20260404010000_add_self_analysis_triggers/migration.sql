-- Add is_internal column to clients
ALTER TABLE "clients" ADD COLUMN "is_internal" BOOLEAN NOT NULL DEFAULT false;

-- Create SystemAnalysisTriggerType enum
CREATE TYPE "system_analysis_trigger_type" AS ENUM ('TICKET_CLOSE', 'POST_ANALYSIS', 'SCHEDULED');

-- Add trigger_type column to system_analyses
ALTER TABLE "system_analyses" ADD COLUMN "trigger_type" "system_analysis_trigger_type" NOT NULL DEFAULT 'TICKET_CLOSE';

-- Make ticket_id nullable on system_analyses
ALTER TABLE "system_analyses" ALTER COLUMN "ticket_id" DROP NOT NULL;

-- Drop the existing foreign key constraint, then recreate with nullable support
ALTER TABLE "system_analyses" DROP CONSTRAINT IF EXISTS "system_analyses_ticket_id_fkey";
ALTER TABLE "system_analyses" ADD CONSTRAINT "system_analyses_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Insert the self client (Bronco internal)
INSERT INTO "clients" ("id", "name", "short_code", "is_internal", "created_at", "updated_at")
VALUES ('00000000-0000-0000-0000-000000000001', 'Bronco (Self)', 'SELF', true, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;
