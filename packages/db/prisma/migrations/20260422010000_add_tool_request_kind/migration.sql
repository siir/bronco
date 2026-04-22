-- CreateEnum
CREATE TYPE "tool_request_kind" AS ENUM ('NEW_TOOL', 'BROKEN_TOOL', 'IMPROVE_TOOL');

-- AlterTable: add kind column with default, backfilling existing rows to NEW_TOOL
ALTER TABLE "tool_requests"
  ADD COLUMN "kind" "tool_request_kind" NOT NULL DEFAULT 'NEW_TOOL';
