-- AlterTable
ALTER TABLE "ai_usage_logs" ADD COLUMN "conversation_metadata" JSONB;

-- CreateTable
CREATE TABLE "ai_prompt_archives" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "usage_log_id" UUID NOT NULL,
    "full_prompt" TEXT NOT NULL,
    "full_response" TEXT NOT NULL,
    "system_prompt" TEXT,
    "conversation_messages" JSONB,
    "total_context_tokens" INTEGER,
    "message_count" INTEGER,
    "summarized_at" TIMESTAMP(3),
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_prompt_archives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_prompt_archives_usage_log_id_key" ON "ai_prompt_archives"("usage_log_id");

-- CreateIndex
CREATE INDEX "ai_prompt_archives_created_at_idx" ON "ai_prompt_archives"("created_at");

-- CreateIndex
CREATE INDEX "ai_prompt_archives_summarized_at_idx" ON "ai_prompt_archives"("summarized_at");

-- AddForeignKey
ALTER TABLE "ai_prompt_archives" ADD CONSTRAINT "ai_prompt_archives_usage_log_id_fkey" FOREIGN KEY ("usage_log_id") REFERENCES "ai_usage_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
