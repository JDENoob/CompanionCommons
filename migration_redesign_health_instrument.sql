-- STEP P10: Health Check-In Instrument Redesign
-- Full spec: docs/CompanionCommons_Health_Instrument_Design.md
--
-- Replaces the old single 1-8 ad-hoc slider per domain with a real,
-- multi-item instrument for Mobility (4 items) and Cognitive (4 items),
-- and moves Energy/Appetite from 1-8 to a single 0-10 item each.
--
-- IMPORTANT — sign convention flips: the old scale was "higher = better"
-- (1 = stiff/bad, 8 = excellent/good). The new scale is "higher = more
-- concerning" (0 = normal/no difficulty, 10 = severe) across every domain,
-- to match how CBPI/CCDR-style veterinary instruments are scored. This
-- migration only changes storage — the app-side sign flip (trend text,
-- alert direction language, peer-comparison "above average" framing,
-- default pre-fill values) is separate application code, not covered here.
--
-- This assumes the tables are empty (confirmed as of the Aug 21 test-data
-- wipe, with no further signups since) — that emptiness is the whole
-- reason this redesign is sequenced before beta recruiting rather than
-- after. If real rows exist by the time this runs, STOP: the old
-- mobility_score/cognitive_score values are on an incompatible scale
-- (1-8, opposite direction) and would silently look like valid 0-10 data
-- after a bare type change — do not run this against non-empty tables
-- without a real backfill/conversion plan first.
--
-- Run this once in the Supabase SQL Editor.

-- ============================================================
-- mobility_checkins — weekly check-in table
-- ============================================================

-- New mobility items (4), 0-10, required every week (NOT NULL not enforced
-- at the DB level since existing rows/older code paths may still insert
-- without them during the staged rollout — app-side validation is the
-- real gate, same pattern as every other column here).
ALTER TABLE mobility_checkins
  ADD COLUMN IF NOT EXISTS mobility_getting_up INTEGER
    CHECK (mobility_getting_up BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS mobility_stairs INTEGER
    CHECK (mobility_stairs BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS mobility_stiffness_after_rest INTEGER
    CHECK (mobility_stiffness_after_rest BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS mobility_walk_distance INTEGER
    CHECK (mobility_walk_distance BETWEEN 0 AND 10);

-- New cognitive items (4), 0-10, only collected every 4th week — nullable
-- on weeks it isn't asked, same pattern the old cognitive_score already used.
ALTER TABLE mobility_checkins
  ADD COLUMN IF NOT EXISTS cognitive_orientation INTEGER
    CHECK (cognitive_orientation BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS cognitive_memory INTEGER
    CHECK (cognitive_memory BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS cognitive_interest INTEGER
    CHECK (cognitive_interest BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS cognitive_sleep_wake INTEGER
    CHECK (cognitive_sleep_wake BETWEEN 0 AND 10);

-- mobility_score/cognitive_score become the stored COMPOSITE (average of
-- the 4 items above, one decimal place) rather than a raw slider value.
-- Kept as the same column name/meaning-slot deliberately — dozens of
-- existing call sites (chart, dashboard trend text, breed guide, peer
-- comparison, Journey Summary) read this column directly, and preserving
-- it avoids rewriting every one of them just to rename a column.
ALTER TABLE mobility_checkins
  ALTER COLUMN mobility_score TYPE NUMERIC(3,1),
  ALTER COLUMN cognitive_score TYPE NUMERIC(3,1);

ALTER TABLE mobility_checkins DROP CONSTRAINT IF EXISTS mobility_checkins_mobility_score_range;
ALTER TABLE mobility_checkins
  ADD CONSTRAINT mobility_checkins_mobility_score_range CHECK (mobility_score BETWEEN 0 AND 10);
ALTER TABLE mobility_checkins DROP CONSTRAINT IF EXISTS mobility_checkins_cognitive_score_range;
ALTER TABLE mobility_checkins
  ADD CONSTRAINT mobility_checkins_cognitive_score_range CHECK (cognitive_score BETWEEN 0 AND 10);

-- Energy/appetite stay single-item, integer, but re-ranged 1-8 -> 0-10.
ALTER TABLE mobility_checkins DROP CONSTRAINT IF EXISTS mobility_checkins_energy_score_range;
ALTER TABLE mobility_checkins
  ADD CONSTRAINT mobility_checkins_energy_score_range CHECK (energy_score BETWEEN 0 AND 10);
ALTER TABLE mobility_checkins DROP CONSTRAINT IF EXISTS mobility_checkins_appetite_score_range;
ALTER TABLE mobility_checkins
  ADD CONSTRAINT mobility_checkins_appetite_score_range CHECK (appetite_score BETWEEN 0 AND 10);

-- ============================================================
-- senior_dogs — one-time baseline, collected at signup
-- ============================================================

ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS baseline_mobility_getting_up INTEGER
    CHECK (baseline_mobility_getting_up BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_mobility_stairs INTEGER
    CHECK (baseline_mobility_stairs BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_mobility_stiffness_after_rest INTEGER
    CHECK (baseline_mobility_stiffness_after_rest BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_mobility_walk_distance INTEGER
    CHECK (baseline_mobility_walk_distance BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_orientation INTEGER
    CHECK (baseline_cognitive_orientation BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_memory INTEGER
    CHECK (baseline_cognitive_memory BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_interest INTEGER
    CHECK (baseline_cognitive_interest BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_sleep_wake INTEGER
    CHECK (baseline_cognitive_sleep_wake BETWEEN 0 AND 10);

ALTER TABLE senior_dogs
  ALTER COLUMN baseline_mobility_score TYPE NUMERIC(3,1),
  ALTER COLUMN baseline_cognitive_score TYPE NUMERIC(3,1);

ALTER TABLE senior_dogs DROP CONSTRAINT IF EXISTS senior_dogs_baseline_mobility_score_range;
ALTER TABLE senior_dogs
  ADD CONSTRAINT senior_dogs_baseline_mobility_score_range CHECK (baseline_mobility_score BETWEEN 0 AND 10);
ALTER TABLE senior_dogs DROP CONSTRAINT IF EXISTS senior_dogs_baseline_cognitive_score_range;
ALTER TABLE senior_dogs
  ADD CONSTRAINT senior_dogs_baseline_cognitive_score_range CHECK (baseline_cognitive_score BETWEEN 0 AND 10);
ALTER TABLE senior_dogs DROP CONSTRAINT IF EXISTS senior_dogs_baseline_energy_score_range;
ALTER TABLE senior_dogs
  ADD CONSTRAINT senior_dogs_baseline_energy_score_range CHECK (baseline_energy_score BETWEEN 0 AND 10);
ALTER TABLE senior_dogs DROP CONSTRAINT IF EXISTS senior_dogs_baseline_appetite_score_range;
ALTER TABLE senior_dogs
  ADD CONSTRAINT senior_dogs_baseline_appetite_score_range CHECK (baseline_appetite_score BETWEEN 0 AND 10);

-- ============================================================
-- magic_link_tokens — staging table the baseline form writes to first,
-- before /verify copies it over to senior_dogs (same shape as senior_dogs'
-- baseline columns, same reasoning as migration_add_weekly_health_fields.sql).
-- ============================================================

ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS baseline_mobility_getting_up INTEGER
    CHECK (baseline_mobility_getting_up BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_mobility_stairs INTEGER
    CHECK (baseline_mobility_stairs BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_mobility_stiffness_after_rest INTEGER
    CHECK (baseline_mobility_stiffness_after_rest BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_mobility_walk_distance INTEGER
    CHECK (baseline_mobility_walk_distance BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_orientation INTEGER
    CHECK (baseline_cognitive_orientation BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_memory INTEGER
    CHECK (baseline_cognitive_memory BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_interest INTEGER
    CHECK (baseline_cognitive_interest BETWEEN 0 AND 10),
  ADD COLUMN IF NOT EXISTS baseline_cognitive_sleep_wake INTEGER
    CHECK (baseline_cognitive_sleep_wake BETWEEN 0 AND 10);

ALTER TABLE magic_link_tokens
  ALTER COLUMN baseline_mobility_score TYPE NUMERIC(3,1),
  ALTER COLUMN baseline_cognitive_score TYPE NUMERIC(3,1);

ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_baseline_mobility_score_range;
ALTER TABLE magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_baseline_mobility_score_range CHECK (baseline_mobility_score BETWEEN 0 AND 10);
ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_baseline_cognitive_score_range;
ALTER TABLE magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_baseline_cognitive_score_range CHECK (baseline_cognitive_score BETWEEN 0 AND 10);
ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_baseline_energy_score_range;
ALTER TABLE magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_baseline_energy_score_range CHECK (baseline_energy_score BETWEEN 0 AND 10);
ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_baseline_appetite_score_range;
ALTER TABLE magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_baseline_appetite_score_range CHECK (baseline_appetite_score BETWEEN 0 AND 10);

-- Forces Supabase's API layer to immediately notice the schema changes
-- above, instead of waiting for its own schema cache to refresh on its
-- own schedule.
NOTIFY pgrst, 'reload schema';
