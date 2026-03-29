-- CreateTable
CREATE TABLE "ticket_filter_presets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status_filter" TEXT,
    "category_filter" TEXT,
    "client_id_filter" UUID,
    "priority_filter" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_filter_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_filter_presets_user_id_idx" ON "ticket_filter_presets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_filter_presets_user_id_name_key" ON "ticket_filter_presets"("user_id", "name");

-- CreateIndex (partial unique: one default per user)
CREATE UNIQUE INDEX "ticket_filter_presets_user_id_default_key" ON "ticket_filter_presets"("user_id") WHERE "is_default" = true;

-- AddForeignKey
ALTER TABLE "ticket_filter_presets" ADD CONSTRAINT "ticket_filter_presets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
