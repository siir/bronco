-- AlterTable
ALTER TABLE "clients" ADD COLUMN "company_profile" TEXT,
ADD COLUMN "systems_profile" TEXT;

-- CreateTable
CREATE TABLE "client_environments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "description" TEXT,
    "operational_instructions" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_environments_pkey" PRIMARY KEY ("id")
);

-- AlterTable: add environment_id to child models
ALTER TABLE "client_integrations" ADD COLUMN "environment_id" UUID;
ALTER TABLE "code_repos" ADD COLUMN "environment_id" UUID;
ALTER TABLE "systems" ADD COLUMN "environment_id" UUID;
ALTER TABLE "tickets" ADD COLUMN "environment_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "client_environments_client_id_tag_key" ON "client_environments"("client_id", "tag");
CREATE INDEX "client_environments_client_id_idx" ON "client_environments"("client_id");
CREATE INDEX "client_integrations_environment_id_idx" ON "client_integrations"("environment_id");
CREATE INDEX "code_repos_environment_id_idx" ON "code_repos"("environment_id");
CREATE INDEX "systems_environment_id_idx" ON "systems"("environment_id");
CREATE INDEX "tickets_environment_id_idx" ON "tickets"("environment_id");

-- AddForeignKey
ALTER TABLE "client_environments" ADD CONSTRAINT "client_environments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_integrations" ADD CONSTRAINT "client_integrations_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "client_environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "code_repos" ADD CONSTRAINT "code_repos_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "client_environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "systems" ADD CONSTRAINT "systems_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "client_environments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "client_environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
