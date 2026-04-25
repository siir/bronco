-- Migration: 20260424000000_add_artifact_attachment_metadata
-- Adds ArtifactKind enum and attachment-metadata columns to the artifacts table.
-- All new columns are nullable for full backward compatibility.
-- Backfills display_name from filename for existing rows.

-- Create the artifact_kind enum
CREATE TYPE "artifact_kind" AS ENUM (
  'PROBE_RESULT',
  'EMAIL_ATTACHMENT',
  'MCP_TOOL_RESULT',
  'OPERATOR_UPLOAD'
);

-- Add new columns to artifacts
ALTER TABLE "artifacts"
  ADD COLUMN "kind"                   "artifact_kind",
  ADD COLUMN "display_name"           TEXT,
  ADD COLUMN "source"                 TEXT,
  ADD COLUMN "added_by_person_id"     UUID REFERENCES "people"("id") ON DELETE SET NULL,
  ADD COLUMN "added_by_system"        TEXT,
  ADD COLUMN "originating_event_id"   TEXT,
  ADD COLUMN "originating_event_type" TEXT;

-- Backfill: set display_name to filename for rows that have no display_name yet
UPDATE "artifacts" SET "display_name" = "filename" WHERE "display_name" IS NULL AND "filename" IS NOT NULL;
