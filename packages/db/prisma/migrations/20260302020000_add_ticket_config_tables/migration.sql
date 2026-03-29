-- CreateTable
CREATE TABLE "ticket_status_configs" (
    "value" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#757575',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status_class" TEXT NOT NULL DEFAULT 'open',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_status_configs_pkey" PRIMARY KEY ("value")
);

-- CreateTable
CREATE TABLE "ticket_category_configs" (
    "value" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#757575',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_category_configs_pkey" PRIMARY KEY ("value")
);

-- Seed default status configs
INSERT INTO "ticket_status_configs" ("value", "display_name", "description", "color", "sort_order", "status_class", "is_active", "updated_at") VALUES
  ('OPEN', 'Open', 'Newly created ticket awaiting triage', '#2196f3', 0, 'open', true, NOW()),
  ('IN_PROGRESS', 'In Progress', 'Actively being worked on', '#ff9800', 1, 'open', true, NOW()),
  ('WAITING', 'Waiting', 'Waiting for external input or response', '#9c27b0', 2, 'open', true, NOW()),
  ('RESOLVED', 'Resolved', 'Issue has been resolved', '#4caf50', 3, 'closed', true, NOW()),
  ('CLOSED', 'Closed', 'Ticket is closed', '#757575', 4, 'closed', true, NOW());

-- Seed default category configs
INSERT INTO "ticket_category_configs" ("value", "display_name", "description", "color", "sort_order", "is_active", "updated_at") VALUES
  ('DATABASE_PERF', 'Database Performance', 'Query performance, blocking, index tuning, health issues', '#f44336', 0, true, NOW()),
  ('BUG_FIX', 'Bug Fix', 'Bugs across database, API, and client applications', '#e91e63', 1, true, NOW()),
  ('FEATURE_REQUEST', 'Feature Request', 'New features for API endpoints or client apps', '#2196f3', 2, true, NOW()),
  ('SCHEMA_CHANGE', 'Schema Change', 'Database schema modifications (new tables, columns, migrations)', '#ff9800', 3, true, NOW()),
  ('CODE_REVIEW', 'Code Review', 'Code review and quality tasks', '#9c27b0', 4, true, NOW()),
  ('ARCHITECTURE', 'Architecture', 'System design and architecture decisions', '#009688', 5, true, NOW()),
  ('GENERAL', 'General', 'Anything that does not fit the above categories', '#757575', 6, true, NOW());
