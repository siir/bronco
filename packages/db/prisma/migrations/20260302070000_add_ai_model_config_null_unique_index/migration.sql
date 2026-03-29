-- Partial unique index to prevent duplicate APP_WIDE rows for the same task type.
-- Postgres treats NULLs as distinct in regular unique indexes, so the existing
-- @@unique([taskType, scope, clientId]) does not prevent duplicates when clientId IS NULL.
CREATE UNIQUE INDEX "ai_model_configs_task_type_scope_null_client_key"
  ON "ai_model_configs" ("task_type", "scope")
  WHERE "client_id" IS NULL;
