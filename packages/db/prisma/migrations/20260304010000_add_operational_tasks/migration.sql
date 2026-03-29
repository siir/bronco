-- CreateEnum
CREATE TYPE "operational_task_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "operational_task_source" AS ENUM ('MANUAL', 'AZURE_DEVOPS');

-- CreateEnum
CREATE TYPE "operational_task_event_type" AS ENUM ('COMMENT', 'STATUS_CHANGE', 'PRIORITY_CHANGE', 'AI_ANALYSIS', 'DEVOPS_INBOUND', 'DEVOPS_OUTBOUND', 'PLAN_PROPOSED', 'PLAN_APPROVED', 'PLAN_REJECTED', 'PLAN_EXECUTING', 'PLAN_COMPLETED', 'SYSTEM_NOTE');

-- CreateTable
CREATE TABLE "operational_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" "operational_task_status" NOT NULL DEFAULT 'OPEN',
    "priority" "priority" NOT NULL DEFAULT 'MEDIUM',
    "source" "operational_task_source" NOT NULL DEFAULT 'MANUAL',
    "external_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_task_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "event_type" "operational_task_event_type" NOT NULL,
    "content" TEXT,
    "metadata" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_task_events_pkey" PRIMARY KEY ("id")
);

-- AlterTable: make DevOpsSyncState.ticketId optional, add operationalTaskId
ALTER TABLE "devops_sync_states" ALTER COLUMN "ticket_id" DROP NOT NULL;
ALTER TABLE "devops_sync_states" ADD COLUMN "operational_task_id" UUID;

-- CreateIndex
CREATE INDEX "operational_tasks_status_idx" ON "operational_tasks"("status");
CREATE INDEX "operational_tasks_created_at_idx" ON "operational_tasks"("created_at");
CREATE INDEX "operational_task_events_task_id_created_at_idx" ON "operational_task_events"("task_id", "created_at");

-- CreateIndex (unique constraint on DevOpsSyncState.operationalTaskId)
CREATE UNIQUE INDEX "devops_sync_states_operational_task_id_key" ON "devops_sync_states"("operational_task_id");

-- AddForeignKey
ALTER TABLE "operational_task_events" ADD CONSTRAINT "operational_task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "operational_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devops_sync_states" ADD CONSTRAINT "devops_sync_states_operational_task_id_fkey" FOREIGN KEY ("operational_task_id") REFERENCES "operational_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ensure exactly one of ticket_id or operational_task_id is set
ALTER TABLE "devops_sync_states" ADD CONSTRAINT "devops_sync_states_one_entity_required" CHECK (num_nonnulls(ticket_id, operational_task_id) = 1);
