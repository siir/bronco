-- CreateEnum
CREATE TYPE "integration_type" AS ENUM ('IMAP', 'AZURE_DEVOPS', 'MCP_DATABASE');

-- CreateTable
CREATE TABLE "client_integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "type" "integration_type" NOT NULL,
    "config" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_integrations_client_id_type_key" ON "client_integrations"("client_id", "type");

-- AddForeignKey
ALTER TABLE "client_integrations" ADD CONSTRAINT "client_integrations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
