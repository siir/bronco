-- Add RESOLVE_THREAD to the route_step_type enum for email thread resolution
ALTER TYPE "route_step_type" ADD VALUE IF NOT EXISTS 'RESOLVE_THREAD' BEFORE 'SUMMARIZE_EMAIL';
