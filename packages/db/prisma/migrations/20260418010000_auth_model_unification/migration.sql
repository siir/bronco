-- Wave 1: Auth model unification (#219).
--
-- Collapses the User / Operator / Person split into a single Person identity
-- with Operator (control panel) and ClientUser (portal) extension tables.
-- Password lives on Person; refresh tokens unified in person_refresh_tokens
-- keyed by accessType (OPERATOR | CLIENT_USER).
--
-- This migration is one-shot: Prisma's _prisma_migrations log prevents it
-- from running twice against the same database, so CREATE TYPE / ALTER TABLE
-- ADD COLUMN statements below are intentionally written without IF NOT EXISTS
-- guards. The steps are structured to leave a consistent final state from a
-- pre-migration database; they are not designed to be rerun.

-- =========================================================================
-- STEP 1: Prepare — add new columns/tables alongside old ones so we can
-- backfill before dropping the old shape.
-- =========================================================================

-- 1a. New enums.
CREATE TYPE "operator_role" AS ENUM ('ADMIN', 'STANDARD');
CREATE TYPE "access_type"   AS ENUM ('OPERATOR', 'CLIENT_USER');

-- 1b. Extend people with email_lower (will backfill from email below).
ALTER TABLE "people" ADD COLUMN "email_lower" TEXT;

-- 1c. Relax the existing (client_id, email) uniqueness on people — we'll
-- enforce global (email_lower) uniqueness instead. Drop after backfill below.

-- 1d. Extend operators with the new columns needed to link to Person.
ALTER TABLE "operators" ADD COLUMN "person_id"        UUID;
ALTER TABLE "operators" ADD COLUMN "role"             "operator_role" NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "operators" ADD COLUMN "theme_preference" TEXT            NOT NULL DEFAULT 'apple';
ALTER TABLE "operators" ADD COLUMN "password_hash"    TEXT;
ALTER TABLE "operators" ADD COLUMN "client_id"        UUID;
ALTER TABLE "operators" ADD COLUMN "last_login_at"    TIMESTAMP(3);

-- 1e. New client_users table.
CREATE TABLE "client_users" (
    "id"            UUID            NOT NULL DEFAULT gen_random_uuid(),
    "person_id"     UUID            NOT NULL,
    "client_id"     UUID            NOT NULL,
    "user_type"     "client_user_type" NOT NULL DEFAULT 'USER',
    "is_primary"    BOOLEAN         NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "created_at"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_users_pkey" PRIMARY KEY ("id")
);

-- 1f. person_refresh_tokens already exists (see 20260411010000_add_person_model).
--     Add the access_type column so we can merge operator refresh tokens in.
ALTER TABLE "person_refresh_tokens" ADD COLUMN "access_type" "access_type";

-- 1g. Add operator_id on ticket_filter_presets (will backfill from user_id).
ALTER TABLE "ticket_filter_presets" ADD COLUMN "operator_id" UUID;

-- =========================================================================
-- STEP 2: Backfill people.email_lower from people.email.
-- =========================================================================
UPDATE "people" SET "email_lower" = lower("email");

-- =========================================================================
-- STEP 3: Collapse duplicate Person rows by email_lower.
--
-- Before the migration, Person was scoped per-client so the same human could
-- appear in multiple Person rows (one per client). The new model is one
-- Person per human (global email). For each email_lower with multiple rows,
-- keep the oldest as the canonical Person and re-point all references to it.
--
-- Prod audit confirms 3 Persons with unique emails, so this is a no-op in
-- prod — but dev environments may have duplicates from seed data.
-- =========================================================================

-- Build a mapping from (old person id) -> (canonical person id).
CREATE TEMP TABLE "_person_collapse" AS
WITH canonical AS (
  SELECT
    lower(email) AS email_lower,
    (array_agg(id ORDER BY created_at ASC))[1] AS canonical_id
  FROM "people"
  GROUP BY lower(email)
)
SELECT
  p.id AS old_id,
  c.canonical_id AS new_id
FROM "people" p
JOIN canonical c ON c.email_lower = lower(p.email)
WHERE p.id <> c.canonical_id;

-- Re-point ticket_followers to the canonical person. If a ticket already has
-- a follower row for the canonical person, skip the duplicate to avoid the
-- (ticket_id, person_id) unique constraint.
UPDATE "ticket_followers" tf
SET "person_id" = pc.new_id
FROM "_person_collapse" pc
WHERE tf."person_id" = pc.old_id
  AND NOT EXISTS (
    SELECT 1 FROM "ticket_followers" existing
    WHERE existing."ticket_id" = tf."ticket_id"
      AND existing."person_id" = pc.new_id
  );

DELETE FROM "ticket_followers" tf
USING "_person_collapse" pc
WHERE tf."person_id" = pc.old_id;

-- Re-point person_refresh_tokens to the canonical person.
UPDATE "person_refresh_tokens" prt
SET "person_id" = pc.new_id
FROM "_person_collapse" pc
WHERE prt."person_id" = pc.old_id;

-- Collapse portal-access flags onto the canonical row — if any duplicate has
-- a passwordHash or portal access, preserve the richest state on the canonical.
-- (Columns still exist at this point; we'll drop them below.)
UPDATE "people" canonical
SET
  "password_hash" = COALESCE(canonical."password_hash", dup."password_hash"),
  "has_portal_access" = canonical."has_portal_access" OR COALESCE(dup."has_portal_access", false),
  "has_ops_access"    = canonical."has_ops_access" OR COALESCE(dup."has_ops_access", false),
  "is_primary"        = canonical."is_primary" OR COALESCE(dup."is_primary", false),
  "user_type"         = COALESCE(canonical."user_type", dup."user_type"),
  "last_login_at"     = GREATEST(canonical."last_login_at", dup."last_login_at"),
  "slack_user_id"     = COALESCE(canonical."slack_user_id", dup."slack_user_id"),
  "phone"             = COALESCE(canonical."phone", dup."phone"),
  "role"              = COALESCE(canonical."role", dup."role")
FROM "_person_collapse" pc
JOIN "people" dup ON dup.id = pc.old_id
WHERE canonical.id = pc.new_id;

-- Finally, drop the duplicate Person rows.
DELETE FROM "people" WHERE id IN (SELECT old_id FROM "_person_collapse");

-- =========================================================================
-- STEP 4: Backfill ClientUser rows.
--
-- For each surviving Person that had portal access or a passwordHash (i.e.
-- was a portal user in the old model), create a ClientUser row to preserve
-- the (person, client) linkage. Also capture primary-contact status here so
-- operators who relied on is_primary keep that flag without needing portal
-- access.
--
-- Per spec: for the prod dataset this is a no-op (0 matching rows). In dev
-- it captures any seed portal users.
-- =========================================================================

INSERT INTO "client_users" ("id", "person_id", "client_id", "user_type", "is_primary", "last_login_at", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  p."id",
  p."client_id",
  -- Old enum values are ADMIN | OPERATOR | USER. We collapse OPERATOR -> USER
  -- for ClientUser (operator-within-client is now modeled via Operator with clientId set).
  CASE
    WHEN p."user_type" = 'ADMIN' THEN 'ADMIN'::"client_user_type"
    ELSE 'USER'::"client_user_type"
  END,
  COALESCE(p."is_primary", false),
  p."last_login_at",
  p."created_at",
  p."updated_at"
FROM "people" p
WHERE p."has_portal_access" = true
   OR p."password_hash" IS NOT NULL
   OR p."is_primary" = true;

-- =========================================================================
-- STEP 5: Backfill Person + Operator rows from the legacy `users` table.
--
-- For each User: find or create a Person (matched by lower(email)), then
-- find or create an Operator pointing at that Person. The Operator carries
-- the password (moved from users.password_hash), the role mapping
-- (ADMIN -> ADMIN, else STANDARD), client_id for scoped ops, theme and
-- lastLoginAt.
-- =========================================================================

-- 5a. Ensure a Person exists for every User email. For Users whose email
-- matches an existing Person, reuse the Person. Otherwise create one.
INSERT INTO "people" ("id", "name", "email", "email_lower", "password_hash", "is_active", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  u."name",
  u."email",
  lower(u."email"),
  NULL, -- password_hash moves onto operators; leave Person.password_hash null until step 6.
  COALESCE(u."is_active", true),
  u."created_at",
  u."updated_at"
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "people" p WHERE p."email_lower" = lower(u."email")
);

-- 5b. Backfill Operator rows for every User.
-- Match by (existing operators.email == users.email) first — the pre-migration
-- schema has 3 Operators that already line up 1:1 with the 4 Users via email.
-- For users with no existing Operator row, create one.

-- 5b-i: Link existing Operators to their matching Person.
UPDATE "operators" o
SET "person_id" = p."id"
FROM "people" p
WHERE p."email_lower" = lower(o."email")
  AND o."person_id" IS NULL;

-- 5b-ii: Carry over User fields onto the matching Operator (or create one if
-- none exists). We express this as an UPSERT keyed by person_id.
INSERT INTO "operators" ("id", "person_id", "role", "theme_preference", "password_hash", "client_id", "last_login_at", "notify_email", "notify_slack", "slack_user_id", "email", "name", "is_active", "is_admin", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  p."id",
  CASE WHEN u."role" = 'ADMIN' THEN 'ADMIN'::"operator_role" ELSE 'STANDARD'::"operator_role" END,
  COALESCE(u."theme_preference", 'apple'),
  u."password_hash",
  u."client_id",
  u."last_login_at",
  true,
  false,
  NULL,
  -- Keep legacy email/name/is_active/is_admin columns populated for the
  -- duration of the migration; they're dropped at the very end.
  u."email",
  u."name",
  COALESCE(u."is_active", true),
  (u."role" = 'ADMIN'),
  u."created_at",
  u."updated_at"
FROM "users" u
JOIN "people" p ON p."email_lower" = lower(u."email")
WHERE NOT EXISTS (
  SELECT 1 FROM "operators" existing WHERE existing."person_id" = p."id"
);

-- 5b-iii: For operators that already existed and now have a person_id, copy
-- the User's password/role/client_id/theme/lastLoginAt onto them. This is
-- the 3-of-4 case in prod (3 operators already matched a user by email).
UPDATE "operators" o
SET
  "password_hash"    = u."password_hash",
  "role"             = CASE WHEN u."role" = 'ADMIN' THEN 'ADMIN'::"operator_role" ELSE 'STANDARD'::"operator_role" END,
  "theme_preference" = COALESCE(u."theme_preference", o."theme_preference"),
  "client_id"        = u."client_id",
  "last_login_at"    = COALESCE(u."last_login_at", o."last_login_at")
FROM "users" u
JOIN "people" p ON p."email_lower" = lower(u."email")
WHERE o."person_id" = p."id"
  AND o."password_hash" IS NULL;

-- 5b-iv: For operators that existed WITHOUT a matching User (shouldn't happen
-- per prod audit), they still have is_admin=true from the last migration.
-- Preserve that by setting role=ADMIN.
UPDATE "operators"
SET "role" = 'ADMIN'::"operator_role"
WHERE "is_admin" = true
  AND "role" = 'STANDARD';

-- =========================================================================
-- STEP 6: Move password hashes from Operator → Person.
--
-- Spec: password lives on Person. Operator.password_hash above is a transient
-- carrier during the migration.
-- =========================================================================

UPDATE "people" p
SET "password_hash" = o."password_hash"
FROM "operators" o
WHERE o."person_id" = p."id"
  AND o."password_hash" IS NOT NULL
  AND p."password_hash" IS NULL;

-- Operators no longer carry the password; drop the column at the end
-- (after we've also re-homed refresh tokens, which don't need it).

-- =========================================================================
-- STEP 7: Backfill person_refresh_tokens.access_type, then merge
-- refresh_tokens (keyed by user_id) into person_refresh_tokens (keyed by
-- person_id + accessType=OPERATOR).
-- =========================================================================

-- 7a. Existing person_refresh_tokens are all portal (CLIENT_USER).
UPDATE "person_refresh_tokens" SET "access_type" = 'CLIENT_USER' WHERE "access_type" IS NULL;

-- 7b. Migrate refresh_tokens → person_refresh_tokens via operator.person_id.
--     Only active (un-revoked) tokens — expired/revoked ones can be dropped.
INSERT INTO "person_refresh_tokens" ("id", "jti", "person_id", "access_type", "expires_at", "revoked_at", "created_at")
SELECT
  gen_random_uuid(),
  rt."jti",
  o."person_id",
  'OPERATOR'::"access_type",
  rt."expires_at",
  rt."revoked_at",
  rt."created_at"
FROM "refresh_tokens" rt
JOIN "users" u     ON u."id" = rt."user_id"
JOIN "people" p    ON p."email_lower" = lower(u."email")
JOIN "operators" o ON o."person_id" = p."id"
WHERE rt."revoked_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "person_refresh_tokens" existing WHERE existing."jti" = rt."jti"
  );

-- =========================================================================
-- STEP 8: Re-point ticket_filter_presets.user_id → operator_id.
-- =========================================================================

UPDATE "ticket_filter_presets" tfp
SET "operator_id" = o."id"
FROM "users" u
JOIN "people" p    ON p."email_lower" = lower(u."email")
JOIN "operators" o ON o."person_id" = p."id"
WHERE tfp."user_id" = u."id"
  AND tfp."operator_id" IS NULL;

-- Drop orphan presets with no matching operator — safer than leaving NULL
-- operator_id rows that violate the NOT NULL constraint we're about to add.
DELETE FROM "ticket_filter_presets" WHERE "operator_id" IS NULL;

-- =========================================================================
-- STEP 9: Drop the old shape and tighten constraints on the new shape.
-- =========================================================================

-- 9a. Drop tables that no longer exist.
DROP TABLE IF EXISTS "refresh_tokens";

-- Drop FK from ticket_filter_presets.user_id -> users.id before we drop users.
ALTER TABLE "ticket_filter_presets" DROP CONSTRAINT IF EXISTS "ticket_filter_presets_user_id_fkey";
ALTER TABLE "ticket_filter_presets" DROP COLUMN IF EXISTS "user_id";

-- Drop existing unique constraint on (user_id, name) if it survives the drop.
ALTER TABLE "ticket_filter_presets" DROP CONSTRAINT IF EXISTS "ticket_filter_presets_user_id_name_key";
DROP INDEX IF EXISTS "ticket_filter_presets_user_id_idx";

-- Drop users table.
DROP TABLE IF EXISTS "users";

-- Drop UserRole enum.
DROP TYPE IF EXISTS "user_role";

-- 9b. Drop legacy columns from operators.
ALTER TABLE "operators" DROP COLUMN IF EXISTS "email";
ALTER TABLE "operators" DROP COLUMN IF EXISTS "name";
ALTER TABLE "operators" DROP COLUMN IF EXISTS "is_active";
ALTER TABLE "operators" DROP COLUMN IF EXISTS "is_admin";
ALTER TABLE "operators" DROP COLUMN IF EXISTS "password_hash";

-- Make operator.person_id NOT NULL (all operators should have one after backfill).
ALTER TABLE "operators" ALTER COLUMN "person_id" SET NOT NULL;

-- 9c. Drop legacy columns from people.
-- FK people.client_id -> clients.id is dropped implicitly when the column is dropped.
ALTER TABLE "people" DROP CONSTRAINT IF EXISTS "people_client_id_fkey";
ALTER TABLE "people" DROP CONSTRAINT IF EXISTS "people_client_id_email_key";
DROP INDEX IF EXISTS "people_client_id_idx";

ALTER TABLE "people" DROP COLUMN IF EXISTS "client_id";
ALTER TABLE "people" DROP COLUMN IF EXISTS "role";
ALTER TABLE "people" DROP COLUMN IF EXISTS "slack_user_id";
ALTER TABLE "people" DROP COLUMN IF EXISTS "is_primary";
ALTER TABLE "people" DROP COLUMN IF EXISTS "user_type";
ALTER TABLE "people" DROP COLUMN IF EXISTS "has_portal_access";
ALTER TABLE "people" DROP COLUMN IF EXISTS "has_ops_access";
ALTER TABLE "people" DROP COLUMN IF EXISTS "last_login_at";

-- Tighten people.email_lower.
ALTER TABLE "people" ALTER COLUMN "email_lower" SET NOT NULL;

-- 9d. Tighten person_refresh_tokens.access_type.
ALTER TABLE "person_refresh_tokens" ALTER COLUMN "access_type" SET NOT NULL;

-- 9e. ClientUserType used to include OPERATOR; the new model drops it. Any
-- ClientUser rows backfilled above already mapped OPERATOR -> USER, so it is
-- safe to drop the enum value.
-- Postgres doesn't support DROP VALUE on ENUM, so rebuild the enum in-place.
ALTER TYPE "client_user_type" RENAME TO "client_user_type_old";
CREATE TYPE "client_user_type" AS ENUM ('ADMIN', 'USER');
ALTER TABLE "client_users" ALTER COLUMN "user_type" DROP DEFAULT;
ALTER TABLE "client_users" ALTER COLUMN "user_type" TYPE "client_user_type" USING (
  CASE "user_type"::text
    WHEN 'ADMIN' THEN 'ADMIN'::"client_user_type"
    ELSE 'USER'::"client_user_type"
  END
);
ALTER TABLE "client_users" ALTER COLUMN "user_type" SET DEFAULT 'USER';
DROP TYPE "client_user_type_old";

-- =========================================================================
-- STEP 10: Indexes, unique constraints, and FKs on the new tables.
-- =========================================================================

-- people: global unique index on email_lower (no longer scoped per client).
CREATE UNIQUE INDEX "people_email_lower_key" ON "people"("email_lower");
CREATE INDEX "people_email_idx" ON "people"("email");

-- operators: unique person_id, indexes on person_id + client_id, FK to clients.
CREATE UNIQUE INDEX "operators_person_id_key" ON "operators"("person_id");
CREATE INDEX "operators_client_id_idx" ON "operators"("client_id");

ALTER TABLE "operators"
  ADD CONSTRAINT "operators_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "operators"
  ADD CONSTRAINT "operators_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- client_users: unique (person_id, client_id), indexes + FKs.
CREATE UNIQUE INDEX "client_users_person_id_client_id_key" ON "client_users"("person_id", "client_id");
CREATE INDEX "client_users_person_id_idx" ON "client_users"("person_id");
CREATE INDEX "client_users_client_id_idx" ON "client_users"("client_id");

ALTER TABLE "client_users"
  ADD CONSTRAINT "client_users_person_id_fkey"
  FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_users"
  ADD CONSTRAINT "client_users_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ticket_filter_presets: tighten operator_id, unique (operator_id, name), FK.
ALTER TABLE "ticket_filter_presets" ALTER COLUMN "operator_id" SET NOT NULL;
CREATE UNIQUE INDEX "ticket_filter_presets_operator_id_name_key" ON "ticket_filter_presets"("operator_id", "name");
CREATE INDEX "ticket_filter_presets_operator_id_idx" ON "ticket_filter_presets"("operator_id");

ALTER TABLE "ticket_filter_presets"
  ADD CONSTRAINT "ticket_filter_presets_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
