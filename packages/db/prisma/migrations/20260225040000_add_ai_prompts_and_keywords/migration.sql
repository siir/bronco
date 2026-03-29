-- CreateEnum
CREATE TYPE "prompt_role" AS ENUM ('SYSTEM', 'USER');

-- CreateTable
CREATE TABLE "ai_prompts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "role" "prompt_role" NOT NULL DEFAULT 'SYSTEM',
    "content" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION,
    "max_tokens" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_keywords" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sample_value" TEXT,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompts_key_key" ON "ai_prompts"("key");

-- CreateIndex
CREATE INDEX "ai_prompts_task_type_idx" ON "ai_prompts"("task_type");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_keywords_token_key" ON "prompt_keywords"("token");

-- CreateIndex
CREATE INDEX "prompt_keywords_category_idx" ON "prompt_keywords"("category");
