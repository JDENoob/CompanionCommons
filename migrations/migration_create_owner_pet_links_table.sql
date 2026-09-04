-- Data-model separation project, Phase 3 (schema only -- see
-- docs/Data_Model_Separation_Build.md for the full Phase 1/2 audit and
-- design rationale this is built against).
--
-- This is the FIRST schema step of a multi-phase, additive-only rollout.
-- Once this migration runs, owner_pet_links exists and is dual-written
-- to alongside senior_dogs (see the Phase 3 server.js changes: /verify
-- and /api/add-dog both insert here immediately after their existing
-- senior_dogs insert, unchanged). NOTHING reads from this table yet --
-- no route's behavior changes as a result of this migration or its
-- accompanying code. senior_dogs keeps its own owner_id/phone/email/
-- zip_code/sms_consent columns exactly as they are today; dropping those
-- is a LATER phase, only after every real call site has been proven to
-- read from owner_pet_links instead (Data_Model_Separation_Build.md's
-- Phase 2 "Migration shape" section names this exact backfill-before-drop
-- ordering).
--
-- Shape, per the confirmed Phase 2 design:
--   - dog_id is the PRIMARY KEY, not owner_id or a separate synthetic id
--     -- a dog belongs to exactly one owner in today's product (no
--     reassignment/sharing feature exists anywhere), so dog_id IS the
--     row's real identity, not an incidental unique column.
--   - owner_id has NO uniqueness constraint of its own -- one owner
--     legitimately has multiple dogs (Multi_Dog_Signup_Build.md's entire
--     premise) -- but does get its own index, since the PK only indexes
--     dog_id and getDogsForOwner()'s lookup direction needs one.
--   - ON DELETE RESTRICT on owner_id, ON DELETE CASCADE on dog_id --
--     deliberately mirrors senior_dogs.owner_id's own current FK
--     behavior exactly (Multi_Dog_Signup_Build.md, Stage 2: RESTRICT,
--     chosen specifically so deleting an owner with linked dogs fails
--     loudly rather than silently orphaning them). Separation must not
--     change this safety behavior as an accidental side effect of moving
--     the column to a new table.
--   - sms_consent lives HERE, not on owners -- a real, decided design
--     fork (Data_Model_Separation_Build.md Phase 2), not an oversight.
--     sms_consent is genuinely captured per-dog today (fresh on every
--     baseline submission, both /verify and /api/add-dog), not per-owner
--     -- moving it to owners would silently collapse an owner's multiple
--     dogs to one shared consent value, a real behavior change this
--     project was never asked to make. Confirmed against every real read
--     site (the reminder cascade, the churn cron, /api/governance/stats,
--     and the ops dashboard's headline metrics) that senior_dogs.sms_consent
--     is the one live, actually-consulted value -- owners.sms_consent
--     does not exist anywhere in this schema's history.
--   - phone/email/zip_code get NO column here at all -- pure owner
--     attributes with zero dog-specific meaning, resolved via a join to
--     owners when a dog-scoped code path needs them (getOwnerContactForDog).
--   - No update/delete function is proposed alongside this table and none
--     is needed by this migration -- nothing in the current app ever
--     reassigns a dog to a different owner or changes sms_consent after
--     initial creation. Deletion is handled entirely by the FK behavior
--     above.
--
-- Access control note (Data_Model_Separation_Build.md Finding 8): this
-- app's entire request path runs on one Supabase client authenticated
-- with the service role key, which bypasses RLS unconditionally. Enabling
-- RLS here (as on every other table since the Aug 26 remediation) is
-- consistent with this schema's existing posture but is not, by itself,
-- a real access boundary against this app's own backend -- the real
-- control is the documented, named-function convention (getOwnerIdForDog,
-- getOwnerContactForDog, getDogsForOwner, createOwnerPetLink): this table
-- is never queried directly anywhere else in server.js. See Finding 8 for
-- the full reasoning and the two real options for a genuinely stricter
-- boundary, neither built here.
--
-- Run this once, in the Supabase SQL Editor. Do NOT run yet per standing
-- project rule -- written for review only.

CREATE TABLE IF NOT EXISTS owner_pet_links (
  dog_id uuid PRIMARY KEY REFERENCES senior_dogs(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  sms_consent boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_owner_pet_links_owner_id ON owner_pet_links(owner_id);

ALTER TABLE public.owner_pet_links ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above, confirm:
--   (a) the table exists with the columns/types above
--   (b) rowsecurity = true
--   (c) the owner_id index exists (separate from the dog_id PK's own
--       auto-created index)
--   (d) the table is genuinely empty right after creation -- this
--       migration only creates the table; backfilling from existing
--       senior_dogs rows (if any exist by the time this runs) is a
--       separate, later step, not part of this migration
-- ============================================================
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'owner_pet_links'
ORDER BY ordinal_position;

SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'owner_pet_links';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'owner_pet_links';

SELECT count(*) AS total_rows FROM owner_pet_links;
