-- AlterTable: change service_alerts.id from TEXT (cuid) to UUID (gen_random_uuid)
-- Step 1: Add a temporary UUID column
ALTER TABLE "service_alerts" ADD COLUMN "new_id" UUID NOT NULL DEFAULT gen_random_uuid();

-- Step 2: Drop the existing primary key constraint
ALTER TABLE "service_alerts" DROP CONSTRAINT "service_alerts_pkey";

-- Step 3: Drop the old TEXT id column
ALTER TABLE "service_alerts" DROP COLUMN "id";

-- Step 4: Rename the new UUID column to id
ALTER TABLE "service_alerts" RENAME COLUMN "new_id" TO "id";

-- Step 5: Re-add the primary key constraint
ALTER TABLE "service_alerts" ADD CONSTRAINT "service_alerts_pkey" PRIMARY KEY ("id");
