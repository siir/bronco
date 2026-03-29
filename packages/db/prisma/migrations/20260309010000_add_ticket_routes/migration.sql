-- CreateEnum
CREATE TYPE "route_step_type" AS ENUM ('SUMMARIZE_EMAIL', 'CATEGORIZE', 'TRIAGE_PRIORITY', 'DRAFT_RECEIPT', 'GENERATE_TITLE', 'EXTRACT_FACTS', 'GATHER_REPO_CONTEXT', 'GATHER_DB_CONTEXT', 'DEEP_ANALYSIS', 'DRAFT_FINDINGS_EMAIL', 'SUGGEST_NEXT_STEPS', 'UPDATE_TICKET_SUMMARY');

-- CreateTable
CREATE TABLE "ticket_routes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "summary" TEXT,
    "category" "ticket_category",
    "client_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_route_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "route_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "step_type" "route_step_type" NOT NULL,
    "task_type_override" TEXT,
    "prompt_key_override" TEXT,
    "config" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_route_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_routes_name_client_id_key" ON "ticket_routes"("name", "client_id");

-- CreateIndex
CREATE INDEX "ticket_routes_category_client_id_is_active_idx" ON "ticket_routes"("category", "client_id", "is_active");

-- CreateIndex
CREATE INDEX "ticket_routes_is_default_is_active_idx" ON "ticket_routes"("is_default", "is_active");

-- CreateIndex
CREATE INDEX "ticket_routes_client_id_idx" ON "ticket_routes"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_route_steps_route_id_step_order_key" ON "ticket_route_steps"("route_id", "step_order");

-- CreateIndex
CREATE INDEX "ticket_route_steps_route_id_is_active_idx" ON "ticket_route_steps"("route_id", "is_active");

-- AddForeignKey
ALTER TABLE "ticket_routes" ADD CONSTRAINT "ticket_routes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_route_steps" ADD CONSTRAINT "ticket_route_steps_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "ticket_routes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
