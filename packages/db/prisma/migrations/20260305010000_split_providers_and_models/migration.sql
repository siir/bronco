-- Split ai_provider_configs into ai_providers (1) and ai_provider_models (many).
-- Preserves existing API keys — for duplicate provider types, last row wins.

-- 1. Create the new providers table
CREATE TABLE "ai_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "base_url" TEXT,
    "encrypted_api_key" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on provider type (one row per provider)
CREATE UNIQUE INDEX "ai_providers_provider_key" ON "ai_providers"("provider");

-- 2. Create the new provider models table
CREATE TABLE "ai_provider_models" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "capability_level" TEXT NOT NULL DEFAULT 'STANDARD',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "enabled_apps" TEXT[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "ai_provider_models_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_provider_models_name_key" ON "ai_provider_models"("name");
CREATE INDEX "ai_provider_models_provider_id_idx" ON "ai_provider_models"("provider_id");
CREATE INDEX "ai_provider_models_capability_level_is_active_idx" ON "ai_provider_models"("capability_level", "is_active");

-- FK from models -> providers
ALTER TABLE "ai_provider_models"
    ADD CONSTRAINT "ai_provider_models_provider_id_fkey"
    FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Migrate data: create one provider row per distinct provider type.
--    For API key and base_url, use the values from the most recently updated row
--    (last one in wins, as requested). Provider is active if ANY of its old rows were active.
INSERT INTO "ai_providers" ("id", "provider", "base_url", "encrypted_api_key", "is_active", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    sub.provider,
    sub.base_url,
    sub.encrypted_api_key,
    sub.is_active,
    sub.created_at,
    sub.updated_at
FROM (
    SELECT DISTINCT ON (provider)
        provider,
        base_url,
        encrypted_api_key,
        -- Provider is active if any model for it was active
        (SELECT bool_or(is_active) FROM ai_provider_configs c2 WHERE c2.provider = c1.provider) AS is_active,
        created_at,
        updated_at
    FROM ai_provider_configs c1
    ORDER BY provider, updated_at DESC
) sub;

-- 4. Migrate each old row as a model, linked to its provider.
INSERT INTO "ai_provider_models" ("id", "provider_id", "name", "model", "capability_level", "is_active", "enabled_apps", "created_at", "updated_at")
SELECT
    old.id,
    p.id,
    old.name,
    old.model,
    old.capability_level,
    old.is_active,
    old.enabled_apps,
    old.created_at,
    old.updated_at
FROM ai_provider_configs old
JOIN ai_providers p ON p.provider = old.provider;

-- 5. Drop the old table
DROP TABLE "ai_provider_configs";
