-- CreateEnum
CREATE TYPE "finance_source_type" AS ENUM ('CREDIT_CARD', 'BANK_ACCOUNT');

-- CreateEnum
CREATE TYPE "finance_import_status" AS ENUM ('PENDING', 'CATEGORIZING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "finance_transaction_type" AS ENUM ('DEBIT', 'CREDIT');

-- CreateTable
CREATE TABLE "finance_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "source_type" "finance_source_type" NOT NULL DEFAULT 'BANK_ACCOUNT',
    "account_label" TEXT,
    "transaction_count" INTEGER NOT NULL DEFAULT 0,
    "status" "finance_import_status" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "import_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "transaction_type" "finance_transaction_type" NOT NULL DEFAULT 'DEBIT',
    "original_category" TEXT,
    "ai_category" TEXT,
    "ai_category_confidence" DOUBLE PRECISION,
    "merchant_name" TEXT,
    "account_label" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_chat_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_imports_user_id_created_at_idx" ON "finance_imports"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "finance_transactions_user_id_date_idx" ON "finance_transactions"("user_id", "date");

-- CreateIndex
CREATE INDEX "finance_transactions_user_id_ai_category_idx" ON "finance_transactions"("user_id", "ai_category");

-- CreateIndex
CREATE INDEX "finance_transactions_import_id_idx" ON "finance_transactions"("import_id");

-- CreateIndex
CREATE INDEX "finance_chat_messages_user_id_created_at_idx" ON "finance_chat_messages"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "finance_imports" ADD CONSTRAINT "finance_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "finance_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_chat_messages" ADD CONSTRAINT "finance_chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
