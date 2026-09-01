-- Adds recurring weight tracking to the every-4th-week check-in (the same
-- trigger that already gates the cognitive/behavior question). This is
-- separate from senior_dogs.weight_lbs, which is the one-time baseline
-- weight collected at signup — this column lets weight be tracked over
-- time the same way mobility/energy/appetite/cognitive already are.
--
-- Run this once in the Supabase SQL Editor.

ALTER TABLE mobility_checkins
  ADD COLUMN IF NOT EXISTS weight_lbs INTEGER;

NOTIFY pgrst, 'reload schema';
