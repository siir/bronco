-- CreateTable
CREATE TABLE "devops_sync_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "work_item_id" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "last_comment_id" INTEGER NOT NULL DEFAULT 0,
    "work_item_type" TEXT NOT NULL,
    "is_actionable" BOOLEAN NOT NULL DEFAULT false,
    "workflow_state" TEXT NOT NULL DEFAULT 'idle',
    "plan_json" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devops_sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devops_sync_states_ticket_id_key" ON "devops_sync_states"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "devops_sync_states_work_item_id_key" ON "devops_sync_states"("work_item_id");

-- CreateIndex
CREATE INDEX "devops_sync_states_workflow_state_idx" ON "devops_sync_states"("workflow_state");

-- AddForeignKey
ALTER TABLE "devops_sync_states" ADD CONSTRAINT "devops_sync_states_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
