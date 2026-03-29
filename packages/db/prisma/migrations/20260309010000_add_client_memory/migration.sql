-- CreateTable: client_memories
-- Per-client operational knowledge that guides AI analysis.

CREATE TABLE "client_memories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "memory_type" TEXT NOT NULL,
    "category" "ticket_category",
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "content" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_memories_client_id_is_active_idx" ON "client_memories"("client_id", "is_active");
CREATE INDEX "client_memories_client_id_category_idx" ON "client_memories"("client_id", "category");
CREATE UNIQUE INDEX "client_memories_client_id_title_key" ON "client_memories"("client_id", "title");

-- AddForeignKey
ALTER TABLE "client_memories" ADD CONSTRAINT "client_memories_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
