-- Adds senior_dogs.age_months (and the matching staging column on
-- magic_link_tokens) so a dog under 1 year old can be registered at all.
--
-- Before this migration, the signup form forced a whole-number "age (in
-- years)" with a hard minimum of 1 -- there was no way, client or server,
-- to register a puppy under 12 months old, which directly contradicted the
-- Aug 20 decision to keep data collection open to all ages (see
-- CompanionCommons_Strategy_and_Legal_Aug20.md Section 4). The existing
-- `age` column is untouched and keeps meaning "whole years" exactly as it
-- always has -- it can now legitimately be 0. `age_months` is the 0-11
-- remainder, so "8 months old" is stored as age=0, age_months=8, and
-- "1 year 3 months" as age=1, age_months=3, rather than forcing either a
-- decimal year (imprecise, ugly to display) or a single combined-months
-- column (would have required rewriting every existing age >= N comparison
-- in the app, e.g. isSeniorForBreed's SENIOR_AGE_BY_TIER thresholds, which
-- are all expressed in whole years).
--
-- NOT NULL DEFAULT 0 so every existing row (there are 0 real senior_dogs
-- rows today, confirmed via the same live-schema-check pattern already
-- established in Link_Revocation_Build.md's Phase 1 audit -- but any
-- disposable/test rows get a safe, correct default) reads as "no partial
-- year," not null/unknown. CHECK constraint mirrors the app-layer 0-11
-- validation at the database level too, matching this project's standing
-- preference for failing loudly rather than silently (see the
-- preferred_contact_method CHECK constraint precedent, Multi_Dog_Signup_
-- Build.md Stage 2).
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS age_months integer NOT NULL DEFAULT 0
    CHECK (age_months >= 0 AND age_months <= 11);

ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS age_months integer NOT NULL DEFAULT 0
    CHECK (age_months >= 0 AND age_months <= 11);

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above
-- ============================================================

-- 1. Confirm both columns exist with the right shape.
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('senior_dogs', 'magic_link_tokens')
  AND column_name = 'age_months'
ORDER BY table_name;

-- 2. Confirm the CHECK constraints exist on both tables.
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname ILIKE '%age_months%';

-- 3. Confirm no existing row was left with an out-of-range or null value
--    (should return 0 for both tables).
SELECT
  (SELECT count(*) FROM senior_dogs WHERE age_months IS NULL OR age_months < 0 OR age_months > 11) AS senior_dogs_bad_rows,
  (SELECT count(*) FROM magic_link_tokens WHERE age_months IS NULL OR age_months < 0 OR age_months > 11) AS magic_link_tokens_bad_rows;
