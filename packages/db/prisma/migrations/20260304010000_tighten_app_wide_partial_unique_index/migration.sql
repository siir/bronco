-- Drop the old partial unique index that only checked client_id IS NULL.
-- It allowed duplicate APP_WIDE + CLIENT rows when client_id was NULL.
DROP INDEX IF EXISTS "ai_model_configs_task_type_scope_null_client_key";

-- Tighter partial unique index: prevent duplicate APP_WIDE rows for the same
-- task type by requiring both client_id IS NULL AND scope = 'APP_WIDE'.
CREATE UNIQUE INDEX "ai_model_configs_task_type_app_wide_unique"
  ON "ai_model_configs" ("task_type")
  WHERE "client_id" IS NULL AND "scope" = 'APP_WIDE';
