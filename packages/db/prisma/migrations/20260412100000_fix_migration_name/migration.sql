-- Fix duplicate migration timestamp from PR #208
UPDATE "_prisma_migrations"
SET "migration_name" = '20260411005959_backfill_general_category'
WHERE "migration_name" = '20260411010000_backfill_general_category';
