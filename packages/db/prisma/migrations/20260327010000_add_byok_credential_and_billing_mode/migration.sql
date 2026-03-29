-- AlterTable
ALTER TABLE "clients" ADD COLUMN "ai_mode" TEXT NOT NULL DEFAULT 'platform';

-- AlterTable
ALTER TABLE "ai_usage_logs" ADD COLUMN "billing_mode" TEXT NOT NULL DEFAULT 'platform';

-- CreateTable
CREATE TABLE "client_ai_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_api_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_ai_credentials_client_id_idx" ON "client_ai_credentials"("client_id");

-- AddForeignKey
ALTER TABLE "client_ai_credentials" ADD CONSTRAINT "client_ai_credentials_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
