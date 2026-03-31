-- Add AZURE_DEVOPS to ticket_source enum (was in schema but never migrated)
ALTER TYPE "ticket_source" ADD VALUE IF NOT EXISTS 'AZURE_DEVOPS';
