-- CreateEnum
CREATE TYPE "release_note_type" AS ENUM ('FEATURE', 'FIX', 'MAINTENANCE', 'OTHER');

-- CreateTable
CREATE TABLE "release_notes" (
    "id" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "commit_date" TIMESTAMP(3) NOT NULL,
    "raw_message" TEXT NOT NULL,
    "summary" TEXT,
    "services" TEXT[],
    "change_type" "release_note_type" NOT NULL DEFAULT 'OTHER',
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "release_notes_commit_sha_key" ON "release_notes"("commit_sha");

-- CreateIndex
CREATE INDEX "release_notes_commit_date_idx" ON "release_notes"("commit_date");

-- CreateIndex
CREATE INDEX "release_notes_change_type_idx" ON "release_notes"("change_type");

-- CreateIndex
CREATE INDEX "release_notes_is_visible_commit_date_idx" ON "release_notes"("is_visible", "commit_date");
