-- CreateEnum
CREATE TYPE "sufficiency_status" AS ENUM ('SUFFICIENT', 'NEEDS_USER_INPUT', 'INSUFFICIENT');

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "sufficiency_status" "sufficiency_status";
