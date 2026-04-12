-- Drop old tables now that all code uses the Person model.
-- Order matters: drop dependent tables first.

-- 1. Drop old refresh tokens (FK to client_users)
DROP TABLE IF EXISTS "client_user_refresh_tokens";

-- 2. Drop old client_users table
DROP TABLE IF EXISTS "client_users";

-- 3. Drop contact_id from ticket_followers (person_id is now the canonical FK)
ALTER TABLE "ticket_followers" DROP CONSTRAINT IF EXISTS "ticket_followers_contact_id_fkey";
DROP INDEX IF EXISTS "ticket_followers_contact_id_idx";
DROP INDEX IF EXISTS "ticket_followers_ticket_id_contact_id_key";
ALTER TABLE "ticket_followers" DROP COLUMN IF EXISTS "contact_id";

-- 4. person_id has been backfilled — make it NOT NULL to match the updated schema
ALTER TABLE "ticket_followers" ALTER COLUMN "person_id" SET NOT NULL;

-- 5. Drop old contacts table
DROP TABLE IF EXISTS "contacts";
