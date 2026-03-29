-- Enforce at most one default environment per client at the DB level.
-- Prisma does not support partial unique indexes natively in schema.prisma,
-- so this is a raw migration only (schema.prisma is left unchanged).

-- Data-fix: clear duplicate defaults (keep the oldest row per client by created_at, then id)
WITH ranked_defaults AS (
  SELECT
    "id",
    "client_id",
    ROW_NUMBER() OVER (
      PARTITION BY "client_id"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS rn
  FROM "client_environments"
  WHERE "is_default" = true
)
UPDATE "client_environments" AS ce
SET "is_default" = false
FROM ranked_defaults AS rd
WHERE ce."id" = rd."id"
  AND rd.rn > 1;

-- Enforce at-most-one-default-per-client at the DB level
CREATE UNIQUE INDEX "client_environments_client_id_is_default_key"
  ON "client_environments"("client_id")
  WHERE "is_default" = true;
