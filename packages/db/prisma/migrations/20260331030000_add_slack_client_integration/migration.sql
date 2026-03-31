-- AlterEnum: Add SLACK to integration_type
ALTER TYPE "integration_type" ADD VALUE 'SLACK';

-- AlterEnum: Add SLACK to ticket_source
ALTER TYPE "ticket_source" ADD VALUE 'SLACK';

-- AlterEnum: Add SLACK_INBOUND and SLACK_OUTBOUND to ticket_event_type
ALTER TYPE "ticket_event_type" ADD VALUE 'SLACK_INBOUND';
ALTER TYPE "ticket_event_type" ADD VALUE 'SLACK_OUTBOUND';

-- AlterTable: Add slack_user_id to contacts
ALTER TABLE "contacts" ADD COLUMN "slack_user_id" TEXT;
