-- Backfill NULL ticket categories with GENERAL so that every ticket has a
-- category and statistics/group-bys don't silently drop uncategorized rows.
UPDATE "tickets" SET "category" = 'GENERAL' WHERE "category" IS NULL;
