-- Add UPDATE_ANALYSIS to the route_step_type enum for incremental reply analysis
ALTER TYPE "route_step_type" ADD VALUE IF NOT EXISTS 'UPDATE_ANALYSIS';
