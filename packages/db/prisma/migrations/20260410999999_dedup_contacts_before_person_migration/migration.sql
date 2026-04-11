-- Deduplicate contacts: keep the most recently updated record per client+email
-- This must run before the person model data migration (20260411010000_add_person_model)
-- which inserts contacts into the people table with a unique(client_id, email) constraint.
DELETE FROM "contacts" c1
USING "contacts" c2
WHERE c1."client_id" = c2."client_id"
  AND lower(c1."email") = lower(c2."email")
  AND c1."id" <> c2."id"
  AND (c1."updated_at" < c2."updated_at" OR (c1."updated_at" = c2."updated_at" AND c1."id" > c2."id"));
