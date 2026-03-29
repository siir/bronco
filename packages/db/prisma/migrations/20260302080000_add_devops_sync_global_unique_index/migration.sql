-- CreateIndex: ensure global (non-integration) sync state remains unique per work item
-- The composite unique on (work_item_id, integration_id) allows duplicate NULLs in Postgres,
-- so we add a partial unique index to enforce uniqueness when integration_id IS NULL.
CREATE UNIQUE INDEX "devops_sync_states_work_item_id_global_key"
  ON "devops_sync_states"("work_item_id")
  WHERE "integration_id" IS NULL;
