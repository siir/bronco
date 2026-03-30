-- CreateTable
CREATE TABLE "operators" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notify_email" BOOLEAN NOT NULL DEFAULT true,
    "notify_slack" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operators_email_key" ON "operators"("email");

-- AlterTable: Add assignedOperatorId to tickets
ALTER TABLE "tickets" ADD COLUMN "assigned_operator_id" UUID;

-- AlterTable: Add approvedByOperatorId to issue_jobs
ALTER TABLE "issue_jobs" ADD COLUMN "approved_by_operator_id" UUID;

-- CreateIndex
CREATE INDEX "tickets_assigned_operator_id_idx" ON "tickets"("assigned_operator_id");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_operator_id_fkey" FOREIGN KEY ("assigned_operator_id") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_jobs" ADD CONSTRAINT "issue_jobs_approved_by_operator_id_fkey" FOREIGN KEY ("approved_by_operator_id") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;
