-- CreateEnum
CREATE TYPE "issue_job_status" AS ENUM ('PENDING', 'CLONING', 'ANALYZING', 'APPLYING', 'PUSHING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "code_repos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "repo_url" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'master',
    "branch_prefix" TEXT NOT NULL DEFAULT 'claude',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "branch_name" TEXT NOT NULL,
    "status" "issue_job_status" NOT NULL DEFAULT 'PENDING',
    "commit_sha" TEXT,
    "files_changed" INTEGER,
    "error" TEXT,
    "ai_model" TEXT,
    "ai_usage" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "code_repos_client_id_repo_url_key" ON "code_repos"("client_id", "repo_url");

-- CreateIndex
CREATE INDEX "issue_jobs_ticket_id_idx" ON "issue_jobs"("ticket_id");

-- CreateIndex
CREATE INDEX "issue_jobs_repo_id_status_idx" ON "issue_jobs"("repo_id", "status");

-- AddForeignKey
ALTER TABLE "code_repos" ADD CONSTRAINT "code_repos_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_jobs" ADD CONSTRAINT "issue_jobs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_jobs" ADD CONSTRAINT "issue_jobs_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "code_repos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
