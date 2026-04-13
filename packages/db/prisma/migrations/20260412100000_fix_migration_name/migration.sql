-- Remove stale migration entry — the renamed directory (20260411005959_backfill_general_category)
-- creates a fresh row when prisma migrate deploy runs, so this UPDATE would produce a duplicate.
-- Simply delete the old row; the renamed migration handles re-insertion.
DELETE FROM "_prisma_migrations"
WHERE "migration_name" = '20260411010000_backfill_general_category';
