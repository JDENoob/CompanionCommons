-- Converts medications.condition_treated from free text to a closed
-- set of values, with an 'other' escape valve carrying its own paired
-- free-text detail column. Full design rationale in the Build Log's
-- dated entry for this change -- summary:
--
--   - Free text on a field this structurally important (what condition
--     is being treated) was a bigger risk surface than it needed to be,
--     and a closed vocabulary is genuinely more analytically useful for
--     the eventual B2B/licensing product -- same reasoning already
--     applied to senior_dogs.treatment_category /
--     medications.category.
--   - 'other' + a paired free-text detail column keeps the door open
--     for a real condition this list doesn't anticipate, without
--     reopening the whole field to arbitrary text.
--   - condition_treated_other_detail is free text, so it gets the exact
--     same B2B/licensing export-exclusion treatment as dog_notes,
--     mobility_checkins.observation, and medication_weekly_updates.note
--     -- see CLAUDE.md's standing rule and the Build Log's dated entry
--     for this change, which makes that rule's scope explicit.
--
-- Confirmed against the live database before writing this: `medications`
-- has 0 rows (checked via a direct Supabase query, not assumed), so
-- adding a CHECK constraint against existing data is safe -- nothing to
-- migrate or reconcile.
--
-- Run this once, in the Supabase SQL Editor, AFTER
-- migration_add_medications.sql has already been run (this migration
-- alters the medications table that one creates).

-- 1. Add the new nullable free-text column. Only ever populated when
--    condition_treated = 'other' -- enforced below by the pairing
--    CHECK, not just by application code.
ALTER TABLE medications
  ADD COLUMN IF NOT EXISTS condition_treated_other_detail text
    CHECK (condition_treated_other_detail IS NULL OR char_length(condition_treated_other_detail) <= 200);

-- 2. Replace the old free-text length-only CHECK on condition_treated
--    with a closed-vocabulary CHECK. Drops the original inline
--    constraint first -- Postgres auto-names a single column-level
--    CHECK as {table}_{column}_check, the same drop-by-name pattern
--    already used in migration_drop_legacy_mobility_check.sql -- so a
--    stale, no-longer-matching constraint can't silently sit alongside
--    the new one.
ALTER TABLE medications
  DROP CONSTRAINT IF EXISTS medications_condition_treated_check;

ALTER TABLE medications
  ADD CONSTRAINT medications_condition_treated_check CHECK (condition_treated IN (
    'arthritis_joint_pain', 'hip_elbow_dysplasia', 'allergies', 'skin_condition',
    'digestive_gi', 'anxiety_behavioral', 'ear_infection', 'chronic_pain_other',
    'post_surgical_recovery', 'other'
  ));

-- 3. Enforce the pairing rule at the DB level too, not just in
--    application code -- the same defense-in-depth pattern already used
--    for date_stopped >= date_started and every other CHECK constraint
--    in the original migration: condition_treated_other_detail must be
--    present (and non-blank) when, and only when,
--    condition_treated = 'other'.
ALTER TABLE medications
  ADD CONSTRAINT medications_condition_treated_other_detail_pairing CHECK (
    (condition_treated = 'other' AND condition_treated_other_detail IS NOT NULL AND char_length(trim(condition_treated_other_detail)) > 0)
    OR
    (condition_treated != 'other' AND condition_treated_other_detail IS NULL)
  );

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above, confirm:
--   (a) the new column exists
--   (b) both new constraints are live with the expected definitions
-- ============================================================
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'medications' AND column_name = 'condition_treated_other_detail';

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'medications'::regclass AND conname IN (
  'medications_condition_treated_check',
  'medications_condition_treated_other_detail_pairing'
);
