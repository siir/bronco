-- CreateIndex
CREATE INDEX "ai_usage_logs_task_type_idx" ON "ai_usage_logs"("task_type");

-- CreateIndex
CREATE INDEX "ai_usage_logs_prompt_key_idx" ON "ai_usage_logs"("prompt_key");
