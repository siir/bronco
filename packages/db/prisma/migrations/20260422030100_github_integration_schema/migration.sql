-- Make ClientIntegration.client_id nullable to allow platform-scoped integrations
-- (e.g. a single platform-wide GITHUB integration used by tool-request issue
-- creation and issue-resolver pushes).
ALTER TABLE "client_integrations"
  ALTER COLUMN "client_id" DROP NOT NULL;

-- Partial unique index: enforce one platform integration per (type, label).
-- The existing composite UNIQUE(client_id, type, label) only covers rows where
-- client_id IS NOT NULL (Postgres treats NULLs as distinct in a UNIQUE
-- constraint), so platform-scoped rows need their own partial index.
CREATE UNIQUE INDEX "client_integrations_platform_type_label_key"
  ON "client_integrations" ("type", "label")
  WHERE "client_id" IS NULL;

-- Add github_integration_id FK on CodeRepo.
ALTER TABLE "code_repos"
  ADD COLUMN "github_integration_id" UUID;

ALTER TABLE "code_repos"
  ADD CONSTRAINT "code_repos_github_integration_id_fkey"
  FOREIGN KEY ("github_integration_id")
  REFERENCES "client_integrations"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "code_repos_github_integration_id_idx"
  ON "code_repos" ("github_integration_id");
