-- AddColumn: slackUserId on client_users
-- Enables Slack sender resolution for self-registered client users (fixes #297)
ALTER TABLE "client_users" ADD COLUMN "slack_user_id" TEXT;
