-- AlterColumn: make services NOT NULL with empty array default
ALTER TABLE "release_notes" ALTER COLUMN "services" SET NOT NULL;
ALTER TABLE "release_notes" ALTER COLUMN "services" SET DEFAULT '{}';
