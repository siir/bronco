-- CreateTable
CREATE TABLE "slack_conversation_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operator_id" UUID NOT NULL,
    "channel_id" TEXT NOT NULL,
    "thread_ts" TEXT NOT NULL,
    "client_id" UUID,
    "messages" JSONB NOT NULL,
    "tool_calls" JSONB,
    "total_cost" DOUBLE PRECISION,
    "total_input_tokens" INTEGER,
    "total_output_tokens" INTEGER,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_conversation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_conversation_logs_channel_id_thread_ts_key" ON "slack_conversation_logs"("channel_id", "thread_ts");

-- CreateIndex
CREATE INDEX "slack_conversation_logs_operator_id_idx" ON "slack_conversation_logs"("operator_id");

-- CreateIndex
CREATE INDEX "slack_conversation_logs_client_id_idx" ON "slack_conversation_logs"("client_id");

-- CreateIndex
CREATE INDEX "slack_conversation_logs_created_at_idx" ON "slack_conversation_logs"("created_at");

-- AddForeignKey
ALTER TABLE "slack_conversation_logs" ADD CONSTRAINT "slack_conversation_logs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_conversation_logs" ADD CONSTRAINT "slack_conversation_logs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
