-- Add theme_preference column to users
ALTER TABLE "users" ADD COLUMN "theme_preference" TEXT NOT NULL DEFAULT 'apple';
