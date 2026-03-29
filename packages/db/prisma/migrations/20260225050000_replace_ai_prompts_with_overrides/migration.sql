-- Drop the old AiPrompt table and PromptRole enum
DROP TABLE IF EXISTS "ai_prompts";
DROP TYPE IF EXISTS "prompt_role";

-- CreateEnum
CREATE TYPE "override_scope" AS ENUM ('APP_WIDE', 'CLIENT');

-- CreateEnum
CREATE TYPE "override_position" AS ENUM ('PREPEND', 'APPEND');

-- CreateTable
CREATE TABLE "prompt_overrides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "prompt_key" TEXT NOT NULL,
    "scope" "override_scope" NOT NULL DEFAULT 'APP_WIDE',
    "client_id" UUID,
    "position" "override_position" NOT NULL DEFAULT 'APPEND',
    "content" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompt_overrides_prompt_key_idx" ON "prompt_overrides"("prompt_key");

-- CreateIndex
CREATE INDEX "prompt_overrides_client_id_idx" ON "prompt_overrides"("client_id");

-- CreateIndex (one override per prompt per scope per client)
CREATE UNIQUE INDEX "prompt_overrides_prompt_key_scope_client_id_key" ON "prompt_overrides"("prompt_key", "scope", "client_id");

-- AddForeignKey
ALTER TABLE "prompt_overrides" ADD CONSTRAINT "prompt_overrides_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
