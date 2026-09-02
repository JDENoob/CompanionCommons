-- Medication-event-triggered opt-in messaging + milestone-payoff. Full
-- design discussion in the Build Log's dated entry for this feature --
-- summary of what this schema encodes:
--
--   - This is NOT a new "keep logging past 12 weeks" mechanism -- that
--     already works with no ceiling (confirmed live in server.js before
--     this feature was scoped: the proactive next-week reminder, the
--     churn-detection/reminder cascade, and formatProgramWeekLabel()
--     display all already run correctly indefinitely past week 12). This
--     table adds medication-event AWARENESS on top of that
--     already-unbounded infrastructure -- it reuses week_number as its
--     own temporal key, same convention as mobility_checkins and
--     medication_weekly_updates, with no upper bound of its own either.
--   - Three trackable event types: a medication STARTED after baseline
--     (a baseline medication has no "before" period to compare against,
--     so only a mid-program addition counts), a medication STOPPED at
--     any point, and a weekly update recording a real CHANGE
--     (change_type = 'changed_switched'). All three represent a real
--     before/after moment worth tracking a trend across.
--   - opt_in_shown / opt_in_response are deliberately separate columns,
--     not one: a row is created the moment a real trigger event happens
--     (opt_in_shown = true, since the row is only ever inserted right as
--     the same request hands back the prompt payload), but
--     opt_in_response stays NULL until the owner actually answers --
--     which may never happen. NULL means "never answered," not "declined"
--     -- only an explicit false means the owner said no.
--   - No owner-identifying column, matching the same hard scoping rule
--     already enforced by construction on medications/
--     medication_weekly_updates -- only dog_id, medication_id, and
--     event-shape fields.
--
-- Confirmed against the live schema before writing this: medications and
-- medication_weekly_updates both already exist and are populated by real
-- app code (migration_add_medications.sql, already run) -- this is a new,
-- additive table referencing both, not a rename or restructure.
--
-- Run this once, in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS medication_response_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE on both FKs, matching medication_weekly_updates'
  -- own reasoning: a response window only has meaning tied to the specific
  -- dog and medication it's about. If either is deleted (account deletion,
  -- test-data cleanup), this row should go with it, not block the delete
  -- or get silently orphaned.
  dog_id uuid NOT NULL REFERENCES senior_dogs(id) ON DELETE CASCADE,
  medication_id uuid NOT NULL REFERENCES medications(id) ON DELETE CASCADE,

  event_type text NOT NULL CHECK (event_type IN ('started', 'stopped', 'changed')),

  -- Plain int, same convention as mobility_checkins.week_number and
  -- medication_weekly_updates.week_number -- not itself a foreign key to
  -- any specific check-in row, week number alone is this app's established
  -- temporal key. No upper bound -- deliberately, per the design note
  -- above.
  event_week_number integer NOT NULL,

  -- true from the moment this row is created (see design note above).
  opt_in_shown boolean NOT NULL DEFAULT true,

  -- NULL = never answered. true = opted in. false = explicitly declined.
  opt_in_response boolean,

  created_at timestamp DEFAULT now()
);

ALTER TABLE public.medication_response_windows ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above, confirm:
--   (a) the table exists with the columns above
--   (b) rowsecurity = true
-- ============================================================
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'medication_response_windows'
ORDER BY ordinal_position;

SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'medication_response_windows';
