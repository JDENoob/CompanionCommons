-- STAGE 2 of the multi-dog owner project: introduces a real Owner entity.
--
-- What this migration DOES:
--   1. Creates the owners table.
--   2. Backfills it from existing senior_dogs data, deduped by phone number
--      (the established key from Stage 1's audit) — one owners row per
--      distinct phone, sourced from that phone's EARLIEST senior_dogs row
--      (by created_at), so backfilled prefs reflect an owner's original
--      stated info rather than whichever dog happened to be entered last.
--   3. Drops the four dead owner_id/owner_name/owner_email/owner_phone
--      columns on senior_dogs (confirmed unused anywhere in server.js
--      during Stage 1's audit — an earlier, abandoned attempt at this same
--      owner concept).
--   4. Adds a NEW, real senior_dogs.owner_id (uuid, FK to owners.id) and
--      links every dog to its deduped owner via the same phone match.
--
-- What this migration does NOT do:
--   - Does NOT touch senior_dogs.phone / .email / .sms_consent. Those stay
--     exactly as-is — the churn cron, the SMS reminder gates, and the
--     check-in route all still read them directly (Stage 1's mapping).
--     Rewiring that logic to read from owners instead is Stage 3+, not
--     this migration.
--   - Does NOT touch preferred_reminder_day/time on senior_dogs either —
--     those are backfilled INTO owners as a starting point, but the
--     senior_dogs copies are left alone for the same reason as above.
--   - Does NOT assign an owner to any senior_dogs row with a NULL phone
--     (old signups from before phone was required for saved profiles).
--     There's nothing to dedup those on — they'll have owner_id = NULL
--     after this runs. That's a real gap for a later stage to decide how
--     to close, not something this migration can resolve on its own.
--
-- Run this once, in order, in the Supabase SQL Editor.

-- ============================================
-- 1. CREATE owners
-- ============================================
-- NOTE (added after this migration was already run against production):
-- this CREATE TABLE is kept up to date here purely for documentation
-- accuracy — owners already exists live in Supabase, so this file is not
-- what actually adds the `name` column below. That was added separately,
-- after the fact, by migration_add_owner_name.sql (Stage 3), since editing
-- an already-executed migration file doesn't retroactively change a live
-- table. Anyone reading this file later should see the real, complete
-- schema; anyone running migrations should still run
-- migration_add_owner_name.sql on its own.
CREATE TABLE IF NOT EXISTS owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  phone text NOT NULL UNIQUE,
  -- Placeholder default until Stage 3's signup form actually asks for this
  -- as a real 3-way choice. Derived below from the existing sms_consent
  -- boolean: true -> 'sms', false/NULL -> 'email'. CHECK constraint below
  -- enforces the allowed values at the DB level too — belt-and-suspenders
  -- alongside the application-layer validation (sanitizeSelect) used for
  -- gender/diet_type/pet_insurance, since a bad value here would silently
  -- break message delivery rather than just being cosmetic.
  preferred_contact_method text CHECK (preferred_contact_method IN ('sms', 'email', 'both')),
  zip_code text,
  preferred_reminder_day integer,
  preferred_reminder_time text,
  -- Added by migration_add_owner_name.sql (Stage 3) — nullable and
  -- optional, not every owner has to provide a name.
  name text,
  created_at timestamp DEFAULT now()
);

-- ============================================
-- 2. BACKFILL owners from senior_dogs, deduped by phone
-- ============================================
-- DISTINCT ON (phone) + ORDER BY phone, created_at ASC picks each phone
-- number's earliest senior_dogs row as the source of truth for backfilled
-- prefs. ON CONFLICT (phone) DO NOTHING makes this safely re-runnable.
INSERT INTO owners (email, phone, preferred_contact_method, zip_code, preferred_reminder_day, preferred_reminder_time, created_at)
SELECT DISTINCT ON (phone)
  email,
  phone,
  CASE WHEN sms_consent = true THEN 'sms' ELSE 'email' END AS preferred_contact_method,
  zip_code,
  preferred_reminder_day,
  preferred_reminder_time,
  created_at
FROM senior_dogs
WHERE phone IS NOT NULL
ORDER BY phone, created_at ASC
ON CONFLICT (phone) DO NOTHING;

-- ============================================
-- 3. DROP the four dead owner_* columns on senior_dogs
-- ============================================
-- Confirmed unused anywhere in server.js during Stage 1's audit. The
-- existing owner_id here is a plain TEXT column with no FK — it must be
-- dropped before step 4 can add a real owner_id, or Postgres will error
-- with "column already exists".
ALTER TABLE senior_dogs
  DROP COLUMN IF EXISTS owner_id,
  DROP COLUMN IF EXISTS owner_name,
  DROP COLUMN IF EXISTS owner_email,
  DROP COLUMN IF EXISTS owner_phone;

-- ============================================
-- 4. ADD the real senior_dogs.owner_id (uuid, FK to owners.id)
-- ============================================
-- ON DELETE RESTRICT: deleting an owner who still has linked dogs fails
-- loudly instead of silently orphaning the dogs' owner_id back to NULL
-- with no signal anything broke.
ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES owners(id) ON DELETE RESTRICT;

-- ============================================
-- 5. LINK each senior_dogs row to its deduped owner
-- ============================================
-- Dogs with a NULL phone are naturally excluded (NULL never equals
-- anything in SQL) and stay owner_id = NULL — see the note at the top.
UPDATE senior_dogs
SET owner_id = owners.id
FROM owners
WHERE senior_dogs.phone = owners.phone;

NOTIFY pgrst, 'reload schema';
