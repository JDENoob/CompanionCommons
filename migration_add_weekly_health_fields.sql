-- Adds energy, appetite, and cognitive/behavior tracking to match the
-- Pet Health Library's 3 promised categories (Mobility, Energy & Appetite,
-- Cognitive & Behavior). Previously only mobility was ever collected.
--
-- Run this once in the Supabase SQL Editor.

ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS baseline_energy_score INTEGER,
  ADD COLUMN IF NOT EXISTS baseline_appetite_score INTEGER,
  ADD COLUMN IF NOT EXISTS baseline_cognitive_score INTEGER;

ALTER TABLE mobility_checkins
  ADD COLUMN IF NOT EXISTS energy_score INTEGER,
  ADD COLUMN IF NOT EXISTS appetite_score INTEGER,
  ADD COLUMN IF NOT EXISTS cognitive_score INTEGER;

-- The baseline form actually writes here FIRST (before /verify copies it
-- over to senior_dogs), so this table needs the same 3 columns too.
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS baseline_energy_score INTEGER,
  ADD COLUMN IF NOT EXISTS baseline_appetite_score INTEGER,
  ADD COLUMN IF NOT EXISTS baseline_cognitive_score INTEGER;

-- ============================================================
-- Fixes the broken weekly reminder SMS system.
--
-- The reminder system was storing phone numbers in a separate,
-- disconnected "users" table with no link back to the dog, so the
-- automatic weekly reminder texts had no phone number to send to
-- and were silently failing (marked "failed - No phone number").
-- This stores the phone number directly on the dog's own profile
-- and on each queued message so reminders can actually be sent.
-- ============================================================

ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT;

ALTER TABLE sms_queue
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- Forces Supabase's API layer to immediately notice the new columns above,
-- instead of waiting for its own schema cache to refresh on its own schedule.
NOTIFY pgrst, 'reload schema';
