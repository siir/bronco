-- AlterTable
ALTER TABLE "release_notes" ADD COLUMN "release_tag" TEXT;

-- CreateIndex
CREATE INDEX "release_notes_release_tag_idx" ON "release_notes"("release_tag");
