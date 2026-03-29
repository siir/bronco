-- CreateEnum
CREATE TYPE "follower_type" AS ENUM ('REQUESTER', 'FOLLOWER');

-- AlterEnum
ALTER TYPE "route_step_type" ADD VALUE 'ADD_FOLLOWER';

-- CreateTable
CREATE TABLE "ticket_followers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "follower_type" "follower_type" NOT NULL DEFAULT 'FOLLOWER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_followers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_followers_ticket_id_contact_id_key" ON "ticket_followers"("ticket_id", "contact_id");

-- CreateIndex
CREATE INDEX "ticket_followers_contact_id_idx" ON "ticket_followers"("contact_id");

-- AddForeignKey
ALTER TABLE "ticket_followers" ADD CONSTRAINT "ticket_followers_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_followers" ADD CONSTRAINT "ticket_followers_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- MigrateData: Copy existing requester_id values to ticket_followers as REQUESTER
INSERT INTO "ticket_followers" ("id", "ticket_id", "contact_id", "follower_type", "created_at")
SELECT gen_random_uuid(), "id", "requester_id", 'REQUESTER', "created_at"
FROM "tickets"
WHERE "requester_id" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "tickets" DROP CONSTRAINT IF EXISTS "tickets_requester_id_fkey";

-- AlterTable
ALTER TABLE "tickets" DROP COLUMN "requester_id";
