-- AlterTable: add integration_id column (nullable for backward compat with global config)
ALTER TABLE "devops_sync_states" ADD COLUMN "integration_id" TEXT;

-- DropIndex: remove the old unique constraint on work_item_id alone
DROP INDEX IF EXISTS "devops_sync_states_work_item_id_key";

-- CreateIndex: composite unique on (work_item_id, integration_id)
CREATE UNIQUE INDEX "devops_sync_states_work_item_id_integration_id_key" ON "devops_sync_states"("work_item_id", "integration_id");
