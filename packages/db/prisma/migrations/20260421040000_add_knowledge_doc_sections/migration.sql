-- AlterTable: templated knowledge-doc section sidecar on Ticket
ALTER TABLE "tickets"
  ADD COLUMN "knowledge_doc_section_meta" JSONB;

-- CreateTable: per-iteration snapshots of the knowledge doc + sidecar
CREATE TABLE "knowledge_doc_snapshots" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "run_id" UUID,
    "iteration" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "section_meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_doc_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_doc_snapshots_ticket_id_created_at_idx"
  ON "knowledge_doc_snapshots"("ticket_id", "created_at");

ALTER TABLE "knowledge_doc_snapshots"
  ADD CONSTRAINT "knowledge_doc_snapshots_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
