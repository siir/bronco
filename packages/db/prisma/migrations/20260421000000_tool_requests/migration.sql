-- CreateEnum
CREATE TYPE "tool_request_status" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'IMPLEMENTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "tool_request_rationale_source" AS ENUM ('INLINE_AGENT_REQUEST', 'POST_HOC_DETECTION', 'MANUAL');

-- CreateTable
CREATE TABLE "tool_requests" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "first_ticket_id" UUID,
    "requested_name" TEXT NOT NULL,
    "display_title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "suggested_inputs" JSONB,
    "example_usage" TEXT,
    "status" "tool_request_status" NOT NULL DEFAULT 'PROPOSED',
    "request_count" INTEGER NOT NULL DEFAULT 1,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "rejected_reason" TEXT,
    "duplicate_of_id" UUID,
    "implemented_in_commit" TEXT,
    "implemented_in_issue" TEXT,
    "github_issue_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_request_rationales" (
    "id" UUID NOT NULL,
    "tool_request_id" UUID NOT NULL,
    "ticket_id" UUID,
    "rationale" TEXT NOT NULL,
    "source" "tool_request_rationale_source" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_request_rationales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tool_requests_client_id_requested_name_key" ON "tool_requests"("client_id", "requested_name");

-- CreateIndex
CREATE INDEX "tool_requests_status_created_at_idx" ON "tool_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "tool_request_rationales_tool_request_id_created_at_idx" ON "tool_request_rationales"("tool_request_id", "created_at");

-- AddForeignKey
ALTER TABLE "tool_requests" ADD CONSTRAINT "tool_requests_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_requests" ADD CONSTRAINT "tool_requests_first_ticket_id_fkey" FOREIGN KEY ("first_ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_requests" ADD CONSTRAINT "tool_requests_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "tool_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_request_rationales" ADD CONSTRAINT "tool_request_rationales_tool_request_id_fkey" FOREIGN KEY ("tool_request_id") REFERENCES "tool_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_request_rationales" ADD CONSTRAINT "tool_request_rationales_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
