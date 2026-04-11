-- CreateTable
CREATE TABLE "people" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT,
    "slack_user_id" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "user_type" "client_user_type",
    "has_portal_access" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jti" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "people_client_id_idx" ON "people"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "people_client_id_email_key" ON "people"("client_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "person_refresh_tokens_jti_key" ON "person_refresh_tokens"("jti");

-- CreateIndex
CREATE INDEX "person_refresh_tokens_person_id_idx" ON "person_refresh_tokens"("person_id");

-- AddForeignKey
ALTER TABLE "people" ADD CONSTRAINT "people_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_refresh_tokens" ADD CONSTRAINT "person_refresh_tokens_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: ticket_followers — contact_id becomes nullable, add person_id
ALTER TABLE "ticket_followers" ALTER COLUMN "contact_id" DROP NOT NULL;
ALTER TABLE "ticket_followers" ADD COLUMN "person_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "ticket_followers_ticket_id_person_id_key" ON "ticket_followers"("ticket_id", "person_id");

-- CreateIndex
CREATE INDEX "ticket_followers_person_id_idx" ON "ticket_followers"("person_id");

-- AddForeignKey
ALTER TABLE "ticket_followers" ADD CONSTRAINT "ticket_followers_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data migration: populate people from contacts and client_users

-- 1. Insert all contacts as people (no portal access)
-- Contacts keep their original UUIDs so ticket_followers.person_id can be set directly
INSERT INTO "people" ("id", "client_id", "name", "email", "phone", "role", "slack_user_id", "is_primary", "has_portal_access", "is_active", "created_at", "updated_at")
SELECT "id", "client_id", "name", "email", "phone", "role", "slack_user_id", "is_primary", false, true, "created_at", "updated_at"
FROM "contacts";

-- 2. Insert client_users that DON'T match an existing contact (by client_id + email)
INSERT INTO "people" ("id", "client_id", "name", "email", "password_hash", "user_type", "has_portal_access", "is_active", "last_login_at", "created_at", "updated_at")
SELECT cu."id", cu."client_id", cu."name", cu."email", cu."password_hash", cu."user_type", true, cu."is_active", cu."last_login_at", cu."created_at", cu."updated_at"
FROM "client_users" cu
WHERE NOT EXISTS (
  SELECT 1 FROM "people" p WHERE p."client_id" = cu."client_id" AND lower(p."email") = lower(cu."email")
);

-- 3. For client_users that DO match a contact, update the person with portal fields
UPDATE "people" p
SET "password_hash" = cu."password_hash",
    "user_type" = cu."user_type",
    "has_portal_access" = true,
    "last_login_at" = cu."last_login_at"
FROM "client_users" cu
WHERE p."client_id" = cu."client_id" AND lower(p."email") = lower(cu."email");

-- 4. Backfill person_id on ticket_followers from contact_id
-- Contact IDs were preserved as Person IDs in step 1
UPDATE "ticket_followers" SET "person_id" = "contact_id" WHERE "contact_id" IS NOT NULL;

-- 5. Migrate refresh tokens
INSERT INTO "person_refresh_tokens" ("id", "jti", "person_id", "expires_at", "revoked_at", "created_at")
SELECT curt."id", curt."jti",
  COALESCE(
    (SELECT p."id" FROM "people" p WHERE p."client_id" = cu."client_id" AND lower(p."email") = lower(cu."email") LIMIT 1),
    curt."user_id"
  ),
  curt."expires_at", curt."revoked_at", curt."created_at"
FROM "client_user_refresh_tokens" curt
JOIN "client_users" cu ON cu."id" = curt."user_id";
