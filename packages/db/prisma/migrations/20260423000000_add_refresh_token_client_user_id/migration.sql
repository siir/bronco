-- AddColumn: PersonRefreshToken.clientUserId
-- Nullable FK to client_users so existing OPERATOR tokens stay NULL and
-- existing CLIENT_USER tokens (pre-fix) also stay NULL and expire naturally.
ALTER TABLE "person_refresh_tokens" ADD COLUMN "client_user_id" UUID REFERENCES "client_users"("id") ON DELETE SET NULL;

-- Index for efficient revocation lookups by clientUserId
CREATE INDEX "person_refresh_tokens_client_user_id_idx" ON "person_refresh_tokens"("client_user_id");
