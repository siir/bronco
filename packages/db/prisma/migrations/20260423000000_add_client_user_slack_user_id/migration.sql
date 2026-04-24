-- AddColumn: slackUserId on client_users
-- Enables Slack sender resolution for self-registered client users (fixes #297)
ALTER TABLE "client_users" ADD COLUMN "slack_user_id" TEXT;

-- AddUniqueIndex: enforce 1:1 mapping between client and Slack user ID
-- Prevents duplicate mappings that would make findUnique ambiguous
CREATE UNIQUE INDEX "client_users_client_id_slack_user_id_key"
  ON "client_users"("client_id", "slack_user_id")
  WHERE "slack_user_id" IS NOT NULL;
