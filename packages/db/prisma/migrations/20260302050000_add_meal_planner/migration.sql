-- CreateEnum
CREATE TYPE "ingredient_category" AS ENUM ('PRODUCE', 'MEAT', 'SEAFOOD', 'DAIRY', 'GRAINS', 'CANNED', 'FROZEN', 'SPICES', 'CONDIMENTS', 'BEVERAGES', 'BAKERY', 'OTHER');

-- CreateEnum
CREATE TYPE "meal_type" AS ENUM ('BREAKFAST', 'LUNCH', 'DINNER', 'SNACK');

-- CreateEnum
CREATE TYPE "meal_rating" AS ENUM ('WINNER', 'GOOD', 'OK', 'SKIP', 'NEVER_AGAIN');

-- CreateEnum
CREATE TYPE "shopping_list_status" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "difficulty_level" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ingredient_category" NOT NULL DEFAULT 'OTHER',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "expires_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "servings" INTEGER NOT NULL DEFAULT 4,
    "prep_time_minutes" INTEGER,
    "cook_time_minutes" INTEGER,
    "difficulty" "difficulty_level" NOT NULL DEFAULT 'MEDIUM',
    "cuisine" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "instructions" TEXT NOT NULL,
    "source_url" TEXT,
    "image_url" TEXT,
    "is_ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "notes" TEXT,
    "is_optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ratings" (
    "id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" "meal_rating" NOT NULL,
    "notes" TEXT,
    "cooked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "week_start_date" TEXT NOT NULL,
    "notes" TEXT,
    "is_ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_plan_entries" (
    "id" UUID NOT NULL,
    "meal_plan_id" UUID NOT NULL,
    "recipe_id" UUID,
    "day_of_week" INTEGER NOT NULL,
    "meal_type" "meal_type" NOT NULL,
    "custom_meal_name" TEXT,
    "servings" INTEGER NOT NULL DEFAULT 2,
    "notes" TEXT,

    CONSTRAINT "meal_plan_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopping_lists" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "meal_plan_id" UUID,
    "name" TEXT NOT NULL,
    "status" "shopping_list_status" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shopping_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopping_list_items" (
    "id" UUID NOT NULL,
    "shopping_list_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ingredient_category" NOT NULL DEFAULT 'OTHER',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "is_purchased" BOOLEAN NOT NULL DEFAULT false,
    "recipe_source" TEXT,
    "notes" TEXT,

    CONSTRAINT "shopping_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_chat_messages" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meal_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_items_user_id_idx" ON "inventory_items"("user_id");
CREATE INDEX "inventory_items_user_id_category_idx" ON "inventory_items"("user_id", "category");
CREATE INDEX "inventory_items_expires_at_idx" ON "inventory_items"("expires_at");

CREATE INDEX "recipes_user_id_idx" ON "recipes"("user_id");
CREATE INDEX "recipes_user_id_cuisine_idx" ON "recipes"("user_id", "cuisine");

CREATE INDEX "recipe_ingredients_recipe_id_idx" ON "recipe_ingredients"("recipe_id");

CREATE INDEX "recipe_ratings_recipe_id_idx" ON "recipe_ratings"("recipe_id");
CREATE INDEX "recipe_ratings_user_id_idx" ON "recipe_ratings"("user_id");

CREATE INDEX "meal_plans_user_id_idx" ON "meal_plans"("user_id");
CREATE INDEX "meal_plans_user_id_week_start_date_idx" ON "meal_plans"("user_id", "week_start_date");

CREATE INDEX "meal_plan_entries_meal_plan_id_idx" ON "meal_plan_entries"("meal_plan_id");

CREATE INDEX "shopping_lists_user_id_idx" ON "shopping_lists"("user_id");
CREATE INDEX "shopping_lists_user_id_status_idx" ON "shopping_lists"("user_id", "status");

CREATE INDEX "shopping_list_items_shopping_list_id_idx" ON "shopping_list_items"("shopping_list_id");

CREATE INDEX "meal_chat_messages_user_id_created_at_idx" ON "meal_chat_messages"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recipe_ratings" ADD CONSTRAINT "recipe_ratings_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_meal_plan_id_fkey" FOREIGN KEY ("meal_plan_id") REFERENCES "meal_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meal_plan_entries" ADD CONSTRAINT "meal_plan_entries_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shopping_lists" ADD CONSTRAINT "shopping_lists_meal_plan_id_fkey" FOREIGN KEY ("meal_plan_id") REFERENCES "meal_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shopping_list_items" ADD CONSTRAINT "shopping_list_items_shopping_list_id_fkey" FOREIGN KEY ("shopping_list_id") REFERENCES "shopping_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
