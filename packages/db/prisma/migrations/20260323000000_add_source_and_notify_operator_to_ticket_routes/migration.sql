-- AlterEnum
ALTER TYPE "route_step_type" ADD VALUE 'NOTIFY_OPERATOR';

-- AlterTable (use ticket_source enum instead of free-form text)
ALTER TABLE "ticket_routes" ADD COLUMN "source" "ticket_source";

-- DropIndex (replaced with new composite index that includes source)
DROP INDEX IF EXISTS "ticket_routes_category_client_id_is_active_idx";

-- CreateIndex
CREATE INDEX "ticket_routes_category_client_id_source_is_active_idx" ON "ticket_routes"("category", "client_id", "source", "is_active");
