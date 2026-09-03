-- Age-under-1 follow-up: drops a stale, pre-existing CHECK constraint on
-- magic_link_tokens.age that migration_add_dog_age_months.sql did not know
-- about and therefore never touched -- the same class of surprise as
-- migration_drop_legacy_mobility_check.sql (STEP P10, Aug 23).
--
-- Found via real end-to-end testing after migration_add_dog_age_months.sql
-- ran: a real signup submission for a genuine 8-month-old puppy (age_years=0,
-- age_months=8 -- exactly the case this whole change exists to support) was
-- rejected with:
--   new row for relation "magic_link_tokens" violates check constraint "age_check"
--
-- Confirmed empirically, not assumed (three disposable probe inserts,
-- immediately deleted): age=0 and age=-1 both rejected by "age_check",
-- age=1 accepted -- this is the ORIGINAL "age >= 1" rule, from before this
-- project ever supported a dog under a year old, still live on this one
-- column. migration_add_dog_age_months.sql only ever added the new
-- age_months column; it never touched any existing constraint on age,
-- because -- like the mobility_check incident -- nothing in this project's
-- prior history had surfaced that one existed here.
--
-- Confirmed senior_dogs.age has NO such constraint (age=0 accepted cleanly,
-- probed the same way) -- this is isolated to magic_link_tokens specifically,
-- the staging table for the two-phase /api/send-magic-link -> /verify
-- signup flow. /api/add-dog (which writes senior_dogs directly, no staging
-- step) was never affected by this constraint at all.
--
-- Run this once in the Supabase SQL Editor.

ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS age_check;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above
-- ============================================================

-- Confirm the constraint is actually gone (should return 0 rows).
SELECT conname
FROM pg_constraint
WHERE conrelid = 'magic_link_tokens'::regclass
  AND conname = 'age_check';
