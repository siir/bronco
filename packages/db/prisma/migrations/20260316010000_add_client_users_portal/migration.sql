-- CreateEnum
CREATE TYPE "client_user_type" AS ENUM ('ADMIN', 'USER');

-- AlterTable
ALTER TABLE "clients" ADD COLUMN "allow_self_registration" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "client_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "user_type" "client_user_type" NOT NULL DEFAULT 'USER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_user_refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "jti" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_user_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_users_email_key" ON "client_users"("email");

-- CreateIndex
CREATE INDEX "client_users_client_id_idx" ON "client_users"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_user_refresh_tokens_jti_key" ON "client_user_refresh_tokens"("jti");

-- CreateIndex
CREATE INDEX "client_user_refresh_tokens_user_id_idx" ON "client_user_refresh_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "client_users" ADD CONSTRAINT "client_users_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_user_refresh_tokens" ADD CONSTRAINT "client_user_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: add portal metadata column to tickets
ALTER TABLE "tickets" ADD COLUMN "metadata" JSONB;
