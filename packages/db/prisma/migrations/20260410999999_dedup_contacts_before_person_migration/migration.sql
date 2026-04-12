-- Deduplicate contacts: keep the most recently updated record per client+email
-- This must run before the person model data migration (20260411010000_add_person_model)
-- which inserts contacts into the people table with a unique(client_id, email) constraint.

-- Step 1: Build a map of duplicate → canonical contact IDs
CREATE TEMP TABLE "_contact_dedup_map" AS
WITH ranked AS (
  SELECT
    "id",
    "client_id",
    lower("email") AS "norm_email",
    ROW_NUMBER() OVER (
      PARTITION BY "client_id", lower("email")
      ORDER BY "updated_at" DESC, "id" ASC
    ) AS rn,
    FIRST_VALUE("id") OVER (
      PARTITION BY "client_id", lower("email")
      ORDER BY "updated_at" DESC, "id" ASC
    ) AS "canonical_id"
  FROM "contacts"
  WHERE "email" IS NOT NULL
)
SELECT "id" AS "duplicate_id", "canonical_id"
FROM ranked
WHERE rn > 1;

-- Step 2: Remap any FK references pointing at duplicate contacts to the canonical ID
-- This prevents FK constraint violations when deleting the duplicates.
-- ticket_followers.contact_id is the known FK; this covers any others generically.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      n2.nspname  AS child_schema,
      t2.relname  AS child_table,
      a2.attname  AS child_col
    FROM pg_constraint con
    JOIN pg_class     t1 ON t1.oid = con.confrelid
    JOIN pg_namespace n1 ON n1.oid = t1.relnamespace
    JOIN pg_class     t2 ON t2.oid = con.conrelid
    JOIN pg_namespace n2 ON n2.oid = t2.relnamespace
    JOIN pg_attribute a2 ON a2.attrelid = t2.oid AND a2.attnum = con.conkey[1]
    JOIN pg_attribute a1 ON a1.attrelid = t1.oid AND a1.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND array_length(con.conkey, 1) = 1
      AND n1.nspname = 'public'
      AND t1.relname = 'contacts'
      AND a1.attname = 'id'
  LOOP
    EXECUTE format(
      'UPDATE %I.%I SET %I = m."canonical_id"
       FROM "_contact_dedup_map" m
       WHERE %I.%I.%I = m."duplicate_id"',
      r.child_schema, r.child_table, r.child_col,
      r.child_schema, r.child_table, r.child_col
    );
  END LOOP;
END $$;

-- Step 3: Delete the duplicate contacts (FKs now point at canonicals)
DELETE FROM "contacts" c
USING "_contact_dedup_map" m
WHERE c."id" = m."duplicate_id";

DROP TABLE "_contact_dedup_map";
