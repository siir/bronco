-- CreateEnum
CREATE TYPE "external_service_check_type" AS ENUM ('HTTP', 'OLLAMA', 'DOCKER');

-- AlterTable: convert check_type from TEXT to enum
ALTER TABLE "external_services"
  ALTER COLUMN "check_type" DROP DEFAULT,
  ALTER COLUMN "check_type" TYPE "external_service_check_type" USING "check_type"::"external_service_check_type",
  ALTER COLUMN "check_type" SET DEFAULT 'HTTP';
