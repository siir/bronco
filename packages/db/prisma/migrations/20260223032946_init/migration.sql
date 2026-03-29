-- CreateEnum
CREATE TYPE "db_engine" AS ENUM ('MSSQL', 'AZURE_SQL_MI', 'POSTGRESQL', 'MYSQL');

-- CreateEnum
CREATE TYPE "auth_method" AS ENUM ('SQL_AUTH', 'WINDOWS_AUTH', 'AZURE_AD');

-- CreateEnum
CREATE TYPE "environment" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT', 'DR');

-- CreateEnum
CREATE TYPE "ticket_status" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ticket_source" AS ENUM ('MANUAL', 'EMAIL', 'AI_DETECTED', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "ticket_event_type" AS ENUM ('COMMENT', 'STATUS_CHANGE', 'ASSIGNMENT', 'AI_ANALYSIS', 'AI_RECOMMENDATION', 'EMAIL_INBOUND', 'EMAIL_OUTBOUND', 'ARTIFACT_ADDED', 'SYSTEM_NOTE');

-- CreateEnum
CREATE TYPE "severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ticket_category" AS ENUM ('DATABASE_PERF', 'BUG_FIX', 'FEATURE_REQUEST', 'SCHEMA_CHANGE', 'CODE_REVIEW', 'ARCHITECTURE', 'GENERAL');

-- CreateEnum
CREATE TYPE "finding_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "short_code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "systems" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "db_engine" "db_engine" NOT NULL DEFAULT 'MSSQL',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 1433,
    "connection_string" TEXT,
    "instance_name" TEXT,
    "default_database" TEXT,
    "auth_method" "auth_method" NOT NULL DEFAULT 'SQL_AUTH',
    "username" TEXT,
    "encrypted_password" TEXT,
    "use_tls" BOOLEAN NOT NULL DEFAULT true,
    "trust_server_cert" BOOLEAN NOT NULL DEFAULT false,
    "connection_timeout" INTEGER NOT NULL DEFAULT 15000,
    "request_timeout" INTEGER NOT NULL DEFAULT 30000,
    "max_pool_size" INTEGER NOT NULL DEFAULT 5,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "environment" "environment" NOT NULL DEFAULT 'PRODUCTION',
    "notes" TEXT,
    "last_connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "systems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "system_id" UUID,
    "requester_id" UUID,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" "ticket_status" NOT NULL DEFAULT 'OPEN',
    "priority" "priority" NOT NULL DEFAULT 'MEDIUM',
    "source" "ticket_source" NOT NULL DEFAULT 'MANUAL',
    "category" "ticket_category",
    "external_ref" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "event_type" "ticket_event_type" NOT NULL,
    "content" TEXT,
    "metadata" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_message_id" TEXT,
    "email_hash" TEXT,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "ticket_id" UUID,
    "finding_id" UUID,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" UUID NOT NULL,
    "system_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "severity" "severity" NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recommendation" TEXT,
    "sql_evidence" TEXT,
    "status" "finding_status" NOT NULL DEFAULT 'OPEN',
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbooks" (
    "id" UUID NOT NULL,
    "finding_id" UUID,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query_audit_logs" (
    "id" UUID NOT NULL,
    "system_id" UUID NOT NULL,
    "query" TEXT NOT NULL,
    "query_hash" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "row_count" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clients_short_code_key" ON "clients"("short_code");

-- CreateIndex
CREATE UNIQUE INDEX "systems_client_id_name_key" ON "systems"("client_id", "name");

-- CreateIndex
CREATE INDEX "tickets_client_id_status_idx" ON "tickets"("client_id", "status");

-- CreateIndex
CREATE INDEX "tickets_client_id_category_idx" ON "tickets"("client_id", "category");

-- CreateIndex
CREATE INDEX "tickets_created_at_idx" ON "tickets"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_events_email_message_id_key" ON "ticket_events"("email_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_events_email_hash_key" ON "ticket_events"("email_hash");

-- CreateIndex
CREATE INDEX "ticket_events_ticket_id_created_at_idx" ON "ticket_events"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "findings_system_id_status_idx" ON "findings"("system_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "playbooks_finding_id_key" ON "playbooks"("finding_id");

-- CreateIndex
CREATE INDEX "query_audit_logs_system_id_created_at_idx" ON "query_audit_logs"("system_id", "created_at");

-- CreateIndex
CREATE INDEX "query_audit_logs_query_hash_idx" ON "query_audit_logs"("query_hash");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "systems" ADD CONSTRAINT "systems_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "query_audit_logs" ADD CONSTRAINT "query_audit_logs_system_id_fkey" FOREIGN KEY ("system_id") REFERENCES "systems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
