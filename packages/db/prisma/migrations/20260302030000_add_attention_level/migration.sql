-- CreateEnum
CREATE TYPE "attention_level" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "log_summaries" ADD COLUMN "attention_level" "attention_level" NOT NULL DEFAULT 'NONE';
