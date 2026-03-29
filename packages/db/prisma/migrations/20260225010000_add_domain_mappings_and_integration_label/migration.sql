-- AlterTable: Add domain_mappings array to clients
ALTER TABLE "clients" ADD COLUMN "domain_mappings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable: Add label column to client_integrations
ALTER TABLE "client_integrations" ADD COLUMN "label" TEXT NOT NULL DEFAULT 'default';

-- DropIndex: Remove old unique constraint (clientId, type)
DROP INDEX "client_integrations_client_id_type_key";

-- CreateIndex: New unique constraint (clientId, type, label)
CREATE UNIQUE INDEX "client_integrations_client_id_type_label_key" ON "client_integrations"("client_id", "type", "label");
