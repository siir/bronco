-- CreateEnum
CREATE TYPE "route_type" AS ENUM ('INGESTION', 'ANALYSIS');

-- AlterEnum
ALTER TYPE "route_step_type" ADD VALUE 'CREATE_TICKET';

-- AlterTable
ALTER TABLE "ticket_routes" ADD COLUMN "route_type" "route_type" NOT NULL DEFAULT 'ANALYSIS';

-- DropIndex (replaced by new composite index including route_type)
DROP INDEX IF EXISTS "ticket_routes_category_client_id_source_is_active_idx";

-- CreateIndex
CREATE INDEX "ticket_routes_route_type_category_client_id_source_is_active_idx" ON "ticket_routes"("route_type", "category", "client_id", "source", "is_active");
