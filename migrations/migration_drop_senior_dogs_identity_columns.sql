-- Data-model separation project, Phase 5 Step 3 (final) -- see
-- docs/Data_Model_Separation_Build.md for the full audit, design
-- rationale, and every prior step's live verification this is built on.
--
-- Drops the 5 identity-bearing columns from senior_dogs: owner_id, phone,
-- email, zip_code, sms_consent. This is the final step of a project that
-- has run in strict, independently-verified stages, each confirmed live
-- before the next began:
--   Phase 3   -- created owner_pet_links, dual-written alongside
--                senior_dogs (both tables populated, senior_dogs still
--                the only one actually read).
--   Phase 4   -- cut over every real access-control checkpoint (14 of
--                them) and every sibling-dog/reminder consumer to read
--                from owner_pet_links/owners instead of senior_dogs.
--   Phase 5   -- Step 1 narrowed the 4 display routes' select('*') calls
--                (columns stayed, just stopped being fetched). Step 2b
--                cut over the two remaining real consumers a fresh
--                full-codebase grep surfaced that the original audit had
--                missed -- the churn-detection cron's bulk query and
--                GET /checkins/:owner_id's sibling-dog query. Step 2
--                (final) stopped WRITING these 5 columns at /verify and
--                /api/add-dog -- owner_pet_links has been the sole write
--                target for identity data since that commit.
--
-- This migration is the only step that is NOT reversible without a fresh
-- backfill from owner_pet_links (the same direction the very first
-- Phase 3 migration's own design doc flagged as the correct one --
-- "a backfill-then-drop, not a drop-then-rebuild, so no data is ever
-- unrecoverable mid-migration"). That backfill-then-drop ordering is
-- exactly what happened here, across five real, separately-verified
-- steps, not compressed into one.
--
-- Confirmed immediately before writing this file, not assumed from
-- Step 2's own verification alone: a direct query against the live
-- senior_dogs table (0 rows total, table-wide count and a full row
-- fetch agreeing) -- there is currently nothing to lose. Real production
-- volume is still zero as of this migration (checklist item 47), which
-- is exactly why this project sequenced the entire separation project
-- ahead of beta recruiting in the first place.
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE senior_dogs
  DROP COLUMN IF EXISTS owner_id,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS zip_code,
  DROP COLUMN IF EXISTS sms_consent;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above
-- ============================================================

-- 1. Confirm all 5 columns are actually gone (should return 0 rows).
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'senior_dogs'
  AND column_name IN ('owner_id', 'phone', 'email', 'zip_code', 'sms_consent');

-- 2. Confirm senior_dogs itself is unharmed -- still has its real
--    remaining columns and the table is still queryable (real column
--    count should match the "32 remaining columns" figure from
--    Data_Model_Separation_Build.md's Phase 2 proposal).
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'senior_dogs'
ORDER BY ordinal_position;

-- 3. Confirm owner_pet_links is untouched and still holds the real,
--    sole copy of identity data going forward.
SELECT count(*) AS total_links FROM owner_pet_links;
