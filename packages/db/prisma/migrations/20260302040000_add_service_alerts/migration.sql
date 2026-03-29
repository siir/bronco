-- CreateTable
CREATE TABLE "service_alerts" (
    "id" TEXT NOT NULL,
    "component_name" TEXT NOT NULL,
    "previous_status" TEXT NOT NULL,
    "new_status" TEXT NOT NULL,
    "notified_via" TEXT[],
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_alerts_component_name_created_at_idx" ON "service_alerts"("component_name", "created_at");
