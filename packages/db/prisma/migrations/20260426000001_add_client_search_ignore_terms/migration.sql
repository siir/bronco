ALTER TABLE "clients" ADD COLUMN "search_ignore_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
