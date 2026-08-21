-- STAGE 3 of the multi-dog owner project: adds the optional owner-name
-- field decided during Stage 3's design (Phase A of the signup form).
--
-- owners already exists live in Supabase (Stage 2 already ran) — this is a
-- separate, additive migration rather than an edit to the already-executed
-- migration_add_owners_table.sql. Nullable and optional, matching the
-- design decision: not every owner has to provide a name, and nothing
-- downstream requires one.
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS name text;

NOTIFY pgrst, 'reload schema';
