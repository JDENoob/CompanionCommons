-- Medication/supplement category-level tracking. Full design discussion
-- and reasoning in the Build Log's dated entry for this feature -- summary
-- of the decisions this schema encodes:
--
--   - Dose is NOT collected, ever, anywhere in this schema. Self-reported
--     dose (not verified against a real prescription) is clinically
--     meaningless and pure liability -- rejected outright, not deferred.
--   - Medication/supplement NAME is deliberately NOT a column here yet.
--     Real drug-name data needs actual autocomplete against a verified
--     veterinary drug list and lawyer review before it's added -- see
--     CompanionCommons_Strategy_and_Legal_Aug20.md Section 7. This schema
--     is built so adding it later is a small, additive migration (one
--     nullable text column, or a normalized lookup table) rather than a
--     redesign -- but the column itself does not exist yet.
--   - Hard scoping rule, enforced by construction, not just by
--     convention: NEITHER table below contains any owner-identifying
--     column (no name/email/phone/zip -- nothing beyond dog_id and
--     health-relevant fields). This makes both tables
--     "separation-compatible" with the identifiable/de-identifiable
--     architecture split already flagged as a real prerequisite for any
--     future drug-name-level data collection, without needing to build
--     that larger separation project first.
--   - Provenance metadata (condition_source, medication_source) is
--     included from day one even though there's currently only one real
--     value for each -- cheap to add now, expensive to retrofit onto
--     rows that already exist without it.
--
-- Confirmed against the live schema before writing this: no
-- medication/drug/treatment/supplement-named table exists anywhere in
-- this project today (checked via the live PostgREST schema, not
-- assumed) -- this is new ground, not a rename or consolidation of
-- something pre-existing. The `category` values below are copied
-- verbatim from server.js's real, currently-live TREATMENT_CATEGORY_LABELS
-- / allowedTreatmentCategories (confirmed identical at both real call
-- sites, /api/send-magic-link and /api/add-dog) -- not assumed from
-- memory or docs.
--
-- Run this once, in the Supabase SQL Editor.

-- ============================================================
-- medications: one row per medication/supplement a dog is (or was) on.
-- A dog can have multiple concurrent rows -- this is the repeating
-- structure, not a flat set of columns on senior_dogs.
-- ============================================================
CREATE TABLE IF NOT EXISTS medications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE (not RESTRICT, unlike senior_dogs.owner_id): a
  -- medication row only has meaning as a description of a specific dog.
  -- If the dog itself is ever deleted (a real account-deletion request,
  -- or test-data cleanup), its medications should go with it, not block
  -- the deletion or get silently orphaned.
  dog_id uuid NOT NULL REFERENCES senior_dogs(id) ON DELETE CASCADE,

  -- Matches senior_dogs.treatment_category's real, live allowed values
  -- exactly (confirmed above). 'none' is included per that same source
  -- vocabulary even though the real add-medication flow never submits it
  -- for an actual added row (you don't "add a medication" and categorize
  -- it as "none") -- kept for exact consistency with the existing
  -- category set rather than unilaterally narrowing it here.
  category text NOT NULL CHECK (category IN (
    'joint_supplement', 'nsaid', 'steroid', 'pain_medication',
    'other_prescription', 'other_supplement', 'none'
  )),

  -- Structured/short, not a free-text notes field -- e.g. "arthritis",
  -- "anxiety", "joint support". Capped at 100 chars, matching this
  -- project's existing short-structured-text convention (e.g.
  -- sanitizeName's own 100-char default).
  condition_treated text NOT NULL CHECK (char_length(condition_treated) <= 100),

  -- Whether the owner is stating their own observation, or relaying
  -- something a vet actually told them -- a real, meaningful provenance
  -- distinction for anyone eventually analyzing this data.
  condition_source text NOT NULL CHECK (condition_source IN (
    'owner_observed', 'owner_reported_vet_diagnosis'
  )),

  date_started date NOT NULL,
  date_stopped date, -- NULL = currently active. Set, never deleted, when stopped.
  CHECK (date_stopped IS NULL OR date_stopped >= date_started),

  -- Single real value today (self-reported at signup/add-time), stored
  -- explicitly rather than assumed -- see the provenance note above.
  -- CHECK constraint kept narrow on purpose (fail loudly if this is ever
  -- set to something unexpected) rather than left as a free string.
  medication_source text NOT NULL DEFAULT 'owner_reported' CHECK (medication_source IN (
    'owner_reported'
  )),

  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

-- ============================================================
-- medication_weekly_updates: the weekly "any changes?" flow's answers.
-- One row per real update a user actually submits -- most weeks
-- generate zero rows for a given medication (no news is not logged).
-- ============================================================
CREATE TABLE IF NOT EXISTS medication_weekly_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: a weekly update only has meaning tied to the
  -- medication it's about.
  medication_id uuid NOT NULL REFERENCES medications(id) ON DELETE CASCADE,

  -- Plain int, matching mobility_checkins.week_number's own convention
  -- (not itself a foreign key to any specific check-in row -- week
  -- number alone is this app's established temporal key).
  week_number integer NOT NULL,

  -- The preset "chip" options from the weekly-update UI design.
  change_type text NOT NULL CHECK (change_type IN (
    'started_new', 'stopped', 'changed_switched', 'side_effect', 'other', 'none'
  )),

  -- Optional short free-text supplement to the chip selection -- length
  -- enforced in application code (sanitizeString), matching how this
  -- project already handles every other short-freeform field, not a DB
  -- CHECK constraint.
  note text,

  created_at timestamp DEFAULT now()
);

ALTER TABLE public.medications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medication_weekly_updates ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- magic_link_tokens.pending_medications: baseline medications can only
-- become real `medications` rows once a real dog_id exists, which for
-- the /verify (magic-link) signup path doesn't happen until the link is
-- actually clicked -- exactly the same reason every other baseline field
-- (weight, spayed_neutered, diet_type, treatment_category, etc.) is
-- already staged on this table first and copied over at /verify time,
-- not inserted anywhere before then. /api/add-dog doesn't need this --
-- it creates the dog synchronously and can insert real medications rows
-- directly in the same request.
-- ============================================================
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS pending_medications jsonb DEFAULT '[]'::jsonb;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above, confirm:
--   (a) both tables exist with the columns above
--   (b) rowsecurity = true for both
-- ============================================================
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('medications', 'medication_weekly_updates')
ORDER BY table_name, ordinal_position;

SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('medications', 'medication_weekly_updates');
