-- AlterEnum: add OPERATOR to ClientUserType
ALTER TYPE "client_user_type" ADD VALUE 'OPERATOR' BEFORE 'USER';

-- AlterTable: operators — add is_admin
ALTER TABLE "operators" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: people — add has_ops_access
ALTER TABLE "people" ADD COLUMN "has_ops_access" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: clients — add notification_mode
ALTER TABLE "clients" ADD COLUMN "notification_mode" TEXT NOT NULL DEFAULT 'client';

-- CreateTable: operator_clients junction
CREATE TABLE "operator_clients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operator_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_clients_operator_id_client_id_key" ON "operator_clients"("operator_id", "client_id");

-- CreateIndex
CREATE INDEX "operator_clients_operator_id_idx" ON "operator_clients"("operator_id");

-- CreateIndex
CREATE INDEX "operator_clients_client_id_idx" ON "operator_clients"("client_id");

-- AddForeignKey
ALTER TABLE "operator_clients" ADD CONSTRAINT "operator_clients_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_clients" ADD CONSTRAINT "operator_clients_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data backfill: set existing operators as platform admins
UPDATE "operators" SET "is_admin" = true;
