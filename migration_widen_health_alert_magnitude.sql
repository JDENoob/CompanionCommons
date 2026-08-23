-- Widens health_alerts.magnitude from INTEGER to NUMERIC(3,1) -- the same
-- precision already used for the composite score columns themselves
-- (mobility_score, cognitive_score, etc. -- see
-- migration_redesign_health_instrument.sql).
--
-- Found via a real 12-week simulated journey (Aug 23): detectHealthAlerts'
-- Stage 4a threshold retune added a composite-only trigger path (a 1.0+
-- move in the 4-item average, not just a single item moving 3+), and a
-- composite-only magnitude is frequently fractional (e.g. 1.5, or
-- 1.2000000000000002 from raw JS float subtraction). Inserting that into
-- an INTEGER column fails outright:
--   invalid input syntax for type integer: "1.5"
-- This was never surfaced anywhere -- caught only as a console warning
-- (`console.warn` in the insert's error branch), the check-in itself still
-- reports success, and the alert is simply lost. Confirmed this is a real,
-- ongoing production gap, not a test-data artifact: it fired twice during
-- the 12-week test (a composite-only mobility recovery, and a
-- near-duplicate the following week), and would fire identically for any
-- real dog's composite-only-triggered alert.
--
-- Confirmed empirically before writing this, not assumed: a direct insert
-- with magnitude=3 (integer, item-triggered shape) succeeds against the
-- current schema; the identical insert with magnitude=1.5 fails with
-- exactly the error above (code 22P02). Item-triggered alerts (a single
-- score item moving 3+, always a whole number) were never affected -- only
-- the composite-only path.
--
-- Run this once in the Supabase SQL Editor.

ALTER TABLE health_alerts
  ALTER COLUMN magnitude TYPE NUMERIC(3,1);

NOTIFY pgrst, 'reload schema';
